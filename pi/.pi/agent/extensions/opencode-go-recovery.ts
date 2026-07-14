/**
 * OpenCode Go Recovery Extension
 *
 * Handles two known issues with the OpenCode Go provider:
 *
 * 1. **Rate-limit errors emitted in-stream** (not as HTTP 429):
 *    The provider emits text like:
 *    ```
 *    Error: 429: {"type":"GoUsageLimitError","message":"5-hour usage
 *    limit reached. Resets in 1hr 19min. To continue using this model
 *    now, enable usage from your available balance: https://..."}
 *    ```
 *    This extension detects the pattern in the stream, aborts the run,
 *    waits for the reset interval (capped at 5 minutes), and sends
 *    "continue" to resume work automatically.
 *
 * 2. **Premature stream ending** without a proper end-of-stream message,
 *    which causes pi's built-in retry to fail. The extension detects
 *    when a run produces no usable assistant message and automatically
 *    retries with exponential backoff.
 *
 * Usage:
 *   Place this file at ~/.pi/agent/extensions/opencode-go-recovery.ts
 *   It is auto-discovered. No flags needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Matches in-stream OpenCode usage-limit error text. */
const USAGE_LIMIT_RE =
  /Error:\s*429:.*"type"\s*:\s*"GoUsageLimitError"/;

/** Extracts time from "Resets in 1hr 19min" / "Resets in 45min" etc. */
const RESET_RE = /Resets in\s+(?:(\d+)\s*hr\s*)?(?:(\d+)\s*min)?/i;

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

/** Default wait when no reset hint is found in the error. */
const DEFAULT_WAIT_MS = 60_000; // 1 minute

/** Cap wait time so we never pause too long. */
const MAX_WAIT_MS = 5 * 60_000; // 5 minutes

/** Base delay for premature-end retries (grows with consecutive failures). */
const PREMATURE_BASE_DELAY_MS = 2_000; // 2 seconds

/** Maximum delay for premature-end retries. */
const PREMATURE_MAX_DELAY_MS = 30_000; // 30 seconds

/** Maximum consecutive failures before giving up. */
const MAX_CONSECUTIVE_FAILURES = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseResetMs(text: string): number | null {
  const m = text.match(RESET_RE);
  if (!m) return null;
  const hours = parseInt(m[1] || "0", 10);
  const minutes = parseInt(m[2] || "0", 10);
  if (hours === 0 && minutes === 0) return null;
  return (hours * 60 + minutes) * 60 * 1000;
}

/** Extract concatenated text from content blocks (works with both
 *  pi's typed content arrays and raw JSON shapes). */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: "text"; text: string } =>
        typeof c === "object" && c !== null && (c as any).type === "text",
    )
    .map((c) => c.text)
    .join("");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ---- per-turn state ----
  let streamText = "";
  let streamContentSeen = false;
  let openCodeError = false;
  let resetMs: number | null = null;
  let prematureEnd = false;
  let lastAssistantCompleted = false;
  let consecutiveFailures = 0;
  let shuttingDown = false;

  // -------------------------------------------------------------------
  // Turn lifecycle
  // -------------------------------------------------------------------

  pi.on("turn_start", () => {
    streamText = "";
    streamContentSeen = false;
    openCodeError = false;
    resetMs = null;
    prematureEnd = false;
    lastAssistantCompleted = false;
  });

  // -------------------------------------------------------------------
  // Session lifecycle – track shutdown to avoid recovery during exit
  // -------------------------------------------------------------------

  pi.on("session_shutdown", () => {
    shuttingDown = true;
  });

  pi.on("session_start", () => {
    shuttingDown = false;
    consecutiveFailures = 0;
  });

  // -------------------------------------------------------------------
  // Stream monitoring – detect in-stream usage-limit errors
  // -------------------------------------------------------------------

  pi.on("message_update", (event, ctx) => {
    const evt = event.assistantMessageEvent;
    if (!evt) return;

    if (evt.type === "content_block_delta") {
      const delta = evt.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === "text_delta" && delta.text) {
        streamText += delta.text;

        // Track that we received actual stream content from the provider.
        streamContentSeen = true;

        if (USAGE_LIMIT_RE.test(streamText)) {
          openCodeError = true;
          if (!resetMs) resetMs = parseResetMs(streamText);
          // Abort the current run immediately – no point waiting.
          ctx.abort();
        }
      }
    }
  });

  // -------------------------------------------------------------------
  // Finalized messages – catch errors we might have missed in streaming
  // -------------------------------------------------------------------

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      lastAssistantCompleted = true;

      const text = extractText(event.message.content);

      if (USAGE_LIMIT_RE.test(text)) {
        openCodeError = true;
        if (!resetMs) resetMs = parseResetMs(text);
      }
    }
  });

  // -------------------------------------------------------------------
  // HTTP-level detection (real 429 status code from the provider)
  // -------------------------------------------------------------------

  pi.on("after_provider_response", (event) => {
    if (event.status === 429) {
      openCodeError = true;

      // Prefer the Retry-After header if present.
      const ra = event.headers?.["retry-after"];
      if (ra && !resetMs) {
        const s = parseInt(ra, 10);
        if (!isNaN(s)) resetMs = s * 1000;
      }
    }
  });

  // -------------------------------------------------------------------
  // Low-level agent run ended – check for premature stream stops
  // -------------------------------------------------------------------

  pi.on("agent_end", (event) => {
    // If the run produced no assistant message at all, or the last
    // assistant message has zero text and zero tool calls, treat it as a
    // premature stream end (the connection dropped before any useful
    // content arrived).
    const messages = event.messages ?? [];
    const lastAssistant = [...messages]
      .reverse()
      .find((m: any) => m?.role === "assistant");

    if (!lastAssistant) {
      prematureEnd = true;
      return;
    }

    const content = extractText((lastAssistant as any).content ?? []);
    const toolCalls: unknown[] = (lastAssistant as any).toolCalls ?? [];
    if (content.length === 0 && toolCalls.length === 0) {
      prematureEnd = true;
    }
  });

  // -------------------------------------------------------------------
  // Recovery – once pi gives up on automatic retries
  // -------------------------------------------------------------------

  pi.on("agent_settled", async (_event, ctx) => {
    // Never auto-recover during session shutdown – the user is trying
    // to exit (Ctrl+D), switch sessions (/new, /resume), or reload.
    // Sending "continue" would restart the agent and block shutdown.
    if (shuttingDown) return;

    // No error → reset the failure counter and move on.
    if (!openCodeError && !prematureEnd) {
      consecutiveFailures = 0;
      return;
    }

    consecutiveFailures++;

    if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
      ctx.ui.notify(
        "OpenCode Go: too many consecutive failures – giving up. " +
          "Check your usage balance or switch providers.",
        "error",
      );
      consecutiveFailures = 0;
      return;
    }

    // ---- Rate-limit case ----
    if (openCodeError) {
      const waitMs = resetMs
        ? Math.min(resetMs, MAX_WAIT_MS)
        : DEFAULT_WAIT_MS;

      ctx.ui.notify(
        `OpenCode Go rate limit hit. ` +
          `Waiting ${Math.round(waitMs / 1000)}s before retrying...`,
        "warning",
      );

      await new Promise((r) => setTimeout(r, waitMs));

      pi.sendUserMessage("continue");
      return;
    }

    // ---- Premature stream end ----
    //
    // Only recover if we actually saw stream content from the provider.
    // A premature end without ever seeing any content block typically
    // means the user manually aborted the run (e.g. Ctrl+C), the
    // connection failed before any data arrived, or pi cancelled the
    // run during session shutdown.  In those cases we should NOT retry.
    if (prematureEnd && streamContentSeen) {
      const delay = Math.min(
        PREMATURE_BASE_DELAY_MS * consecutiveFailures,
        PREMATURE_MAX_DELAY_MS,
      );

      ctx.ui.notify(
        `OpenCode Go stream ended prematurely. ` +
          `Retrying in ${Math.round(delay / 1000)}s ` +
          `(attempt ${consecutiveFailures})...`,
        "warning",
      );

      await new Promise((r) => setTimeout(r, delay));

      pi.sendUserMessage("continue");
      return;
    }
  });
}
