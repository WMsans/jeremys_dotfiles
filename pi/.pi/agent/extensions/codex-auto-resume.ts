/**
 * Codex Auto-Resume Extension
 *
 * The `openai-codex` provider can fail a run with:
 *   Error: Codex error: The usage limit has been reached
 * (pi-keep-going never matched this message, so the work just stopped.)
 *
 * This extension detects exactly that failure and auto-continues when the
 * limit resets:
 * - Fetches the real reset time from the Codex usage API
 *   (GET https://chatgpt.com/backend-api/wham/usage, same endpoint
 *   pi-keep-going used) and waits until then.
 * - Falls back to bounded polling with backoff when no reset time is
 *   available, then sends "continue" to resume the work.
 *
 * Subagent support:
 * - Subagent child processes are spawned with PI_SUBAGENT=1 in the
 *   environment. Inside such a process this extension stays dormant and
 *   fails fast — the *parent* side (extensions/subagent/index.ts) detects
 *   the Codex-limit failure and re-spawns the subagent after waiting for
 *   the reset. Waiting hours inside a headless child would hang the
 *   parent with no UI, so the retry must live in the parent.
 *
 * Safety:
 * - Only acts on Codex usage-limit errors (stopReason "error").
 *   Manual aborts (stopReason "aborted") and any other error never trigger it.
 * - Never acts during session shutdown (user exiting / /new / /resume).
 * - Aborts the wait if the user starts a new turn meanwhile (no hijacking).
 * - Yields to free-limit-fallback / opencode-go-recovery: those own
 *   FreeUsageLimitError and GoUsageLimitError; this owns only Codex errors.
 *
 * Usage:
 *   Place in ~/.pi/agent/extensions/ (auto-discovered). Enabled by default.
 *     /codex-resume status -> show state (waiting, failures, reset time)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Detection (pure, shared with the subagent parent-side retry)
// ---------------------------------------------------------------------------

const CODEX_PROVIDER = "openai-codex";

/** The exact error pi surfaces when the Codex limit is hit. */
const CODEX_EXACT_RE =
	/Codex error:\s*The usage limit has been reached/i;

/**
 * True for a Codex usage-limit failure.
 * - Always true for the exact "Codex error: The usage limit has been
 *   reached" message, regardless of provider (the message is Codex-specific).
 * - Otherwise true when the active provider is openai-codex and the message
 *   looks like a usage/rate limit (covers "hit your ChatGPT usage limit",
 *   usage_limit_reached, 429s, ...).
 */
export function isCodexLimitError(
	errorMessage: string | undefined | null,
	provider?: string,
): boolean {
	if (!errorMessage) return false;
	if (CODEX_EXACT_RE.test(errorMessage)) return true;
	if (provider === CODEX_PROVIDER) {
		return (
			/usage.?limit/i.test(errorMessage) ||
			/hit your ChatGPT/i.test(errorMessage) ||
			/rate.?limit/i.test(errorMessage) ||
			/\b429\b/.test(errorMessage)
		);
	}
	return false;
}

/** Scan settled-run messages for a Codex-limit error. */
export function hasCodexLimitMessage(
	messages: Array<{ stopReason?: string; errorMessage?: string }> | undefined | null,
	provider?: string,
): boolean {
	if (!messages) return false;
	return messages.some(
		(m) => m.stopReason === "error" && isCodexLimitError(m.errorMessage, provider),
	);
}

// ---------------------------------------------------------------------------
// Codex usage API (reset-time lookup)
// ---------------------------------------------------------------------------

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FETCH_TIMEOUT_MS = 10_000;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const part = token.split(".")[1];
		if (!part) return null;
		const json = Buffer.from(
			part.replace(/-/g, "+").replace(/_/g, "/"),
			"base64",
		).toString("utf-8");
		const payload = JSON.parse(json) as unknown;
		return typeof payload === "object" && payload !== null
			? (payload as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function codexAccountId(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	if (!payload) return undefined;
	const auth = payload["https://api.openai.com/auth"];
	if (auth && typeof auth === "object") {
		const id = (auth as Record<string, unknown>).chatgpt_account_id;
		if (typeof id === "string" && id.length > 0) return id;
	}
	for (const key of ["chatgpt_account_id", "account_id"]) {
		const value = payload[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parse reset time from a wham/usage body. Returns epoch ms or null. */
export function codexResetFromBody(body: unknown, now: number): number | null {
	const b = body as Record<string, unknown> | null;
	const rateLimit =
		b && typeof b.rate_limit === "object" && b.rate_limit !== null
			? (b.rate_limit as Record<string, unknown>)
			: null;
	const primary =
		rateLimit && typeof rateLimit.primary_window === "object" && rateLimit.primary_window !== null
			? (rateLimit.primary_window as Record<string, unknown>)
			: null;
	if (!primary) return null;
	const resetAt = num(primary.reset_at);
	if (resetAt !== null) return resetAt * 1000;
	const resetAfter = num(primary.reset_after_seconds);
	if (resetAfter !== null) return now + Math.round(resetAfter * 1000);
	return null;
}

/** Best-effort reset-time lookup. Returns epoch ms, or null on any failure. */
async function fetchCodexReset(
	token: string,
	signal: AbortSignal,
): Promise<number | null> {
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			"User-Agent": "pi-codex-auto-resume",
		};
		const accountId = codexAccountId(token);
		if (accountId) headers["ChatGPT-Account-Id"] = accountId;

		const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
		const combined = signal.aborted ? signal : AbortSignal.any([signal, timeout]);
		const res = await fetch(CODEX_USAGE_URL, { headers, signal: combined });
		if (!res.ok) return null;
		const body: unknown = await res.json();
		return codexResetFromBody(body, Date.now());
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll cadence when a reset time is known (re-check the API periodically). */
const POLL_INTERVAL_MS = 60_000;
/** Chunk size for interruptible sleeps (shutdown / user-takeover checks). */
const SLEEP_CHUNK_MS = 15_000;
/** Give up waiting after this long (Codex windows reset within hours). */
const MAX_WAIT_MS = 8 * 3600_000;
/** Give up after this many consecutive failed auto-resumes. */
const MAX_CONSECUTIVE_RESUMES = 10;
/** Backoff when no reset time is known (per consecutive failure). */
const UNKNOWN_RESET_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];

const fmtClock = (at: number): string => {
	const d = new Date(at);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const fmtDur = (ms: number): string => {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h${m % 60 > 0 ? ` ${m % 60}m` : ""}`;
};

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let limitHit = false;
	let hitProvider: string | undefined;
	let recovering = false;
	let consecutiveResumes = 0;
	let shuttingDown = false;
	let waitingUntil: number | null = null;

	const resetTurnState = () => {
		limitHit = false;
		hitProvider = undefined;
	};

	pi.on("session_start", () => {
		shuttingDown = false;
		recovering = false;
		consecutiveResumes = 0;
		waitingUntil = null;
		resetTurnState();
	});

	pi.on("session_shutdown", () => {
		shuttingDown = true;
	});

	pi.on("turn_start", () => {
		resetTurnState();
	});

	// Detection: only Codex-limit errors on failed runs.
	pi.on("agent_end", (event, ctx) => {
		const provider = (ctx.model as { provider?: string } | undefined)?.provider;
		const messages = (event.messages ?? []) as Array<{
			stopReason?: string;
			errorMessage?: string;
		}>;
		for (const m of messages) {
			if (m.stopReason === "error" && isCodexLimitError(m.errorMessage, provider)) {
				limitHit = true;
				hitProvider = provider;
				break;
			}
		}
	});

	pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
		if (shuttingDown) return;

		// Inside a subagent child process: stay dormant and fail fast.
		// The parent-side subagent tool owns the wait-and-retry there.
		if (process.env.PI_SUBAGENT === "1") return;

		// Successful run (or a failure we don't own): reset and move on.
		if (!limitHit) {
			consecutiveResumes = 0;
			waitingUntil = null;
			return;
		}
		// Detection already gates on the Codex provider (or the exact
			// Codex-specific message), so anything reaching here is ours —
			// never fight the opencode fallback/recovery extensions over
			// their error types.
		resetTurnState();

		// A recovery loop is already waiting — don't stack another one.
		// (A second agent_settled for the same outage just re-arms the flag,
		// which the active loop will observe via consecutiveResumes.)
		if (recovering) return;

		consecutiveResumes++;
		if (consecutiveResumes > MAX_CONSECUTIVE_RESUMES) {
			ctx.ui.notify(
				`Codex auto-resume: still limited after ${MAX_CONSECUTIVE_RESUMES} retries — giving up. ` +
					`Switch models with /model or wait for the reset.`,
				"error",
			);
			consecutiveResumes = 0;
			waitingUntil = null;
			return;
		}

		recovering = true;
		try {
			await waitForResetAndContinue(ctx);
		} finally {
			recovering = false;
		}
	});

	async function waitForResetAndContinue(ctx: ExtensionContext): Promise<void> {
		const abortSignal: AbortSignal | undefined = (ctx as { signal?: AbortSignal }).signal;

		const shouldAbort = () => shuttingDown || !ctx.isIdle() || abortSignal?.aborted === true;

		// Best-effort precise reset time from the Codex usage API.
		let resetAt: number | null = null;
		try {
			const token = await ctx.modelRegistry.getApiKeyForProvider(CODEX_PROVIDER);
			if (token && !shouldAbort()) {
				resetAt = await fetchCodexReset(token, abortSignal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS));
			}
		} catch {
			resetAt = null;
		}

		const startedAt = Date.now();
		if (resetAt !== null && resetAt > startedAt) {
			waitingUntil = resetAt;
			ctx.ui.notify(
				`Codex usage limit reached — auto-resuming at ~${fmtClock(resetAt)} ` +
					`(in ${fmtDur(resetAt - startedAt)}).`,
				"warning",
			);
		} else {
			const backoff =
				UNKNOWN_RESET_BACKOFF_MS[
					Math.min(consecutiveResumes - 1, UNKNOWN_RESET_BACKOFF_MS.length - 1)
				];
			resetAt = startedAt + backoff;
			waitingUntil = resetAt;
			ctx.ui.notify(
				`Codex usage limit reached — no reset time available, retrying in ${fmtDur(backoff)} ` +
					`(attempt ${consecutiveResumes}/${MAX_CONSECUTIVE_RESUMES}).`,
				"warning",
			);
		}

		// Interruptible wait: re-check the usage API each poll interval so an
		// early reset resumes immediately, and bail out if the user takes over
		// or the session shuts down.
		while (Date.now() < (waitingUntil ?? Date.now())) {
			const chunk = Math.min(
				SLEEP_CHUNK_MS,
				(waitingUntil ?? Date.now()) - Date.now(),
				POLL_INTERVAL_MS,
			);
			if (chunk > 0) await sleep(chunk);
			if (shouldAbort()) {
				waitingUntil = null;
				return;
			}
			// Opportunistic re-check: if the API now reports a reset that has
			// already passed, stop waiting early.
			if (Date.now() + SLEEP_CHUNK_MS < (waitingUntil ?? 0)) {
				try {
					const token = await ctx.modelRegistry.getApiKeyForProvider(CODEX_PROVIDER);
					if (token) {
						const fresh = await fetchCodexReset(
							token,
							abortSignal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
						);
						if (fresh !== null && fresh <= Date.now()) break;
						if (fresh !== null && fresh > Date.now() && fresh < (waitingUntil ?? Infinity)) {
							waitingUntil = fresh;
						}
					}
				} catch {
					/* keep waiting */
				}
			}
			if (Date.now() - startedAt >= MAX_WAIT_MS) {
				ctx.ui.notify(
					"Codex auto-resume: waited 8h without a reset — giving up. " +
						"Switch models with /model or retry later with \"continue\".",
					"error",
				);
				consecutiveResumes = 0;
				waitingUntil = null;
				return;
			}
		}

		waitingUntil = null;
		if (shouldAbort()) return;
		// The user may have started a new turn during the wait — don't hijack it.
		if (!ctx.isIdle()) return;
		pi.sendUserMessage("continue");
	}

	pi.registerCommand("codex-resume", {
		description: "Codex auto-resume status (auto-continues when the Codex limit resets)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "status" || arg === "") {
				const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
				const wait =
					waitingUntil !== null
						? `waiting until ~${fmtClock(waitingUntil)} (in ${fmtDur(Math.max(0, waitingUntil - Date.now()))})`
						: "idle";
				ctx.ui.notify(
					`Codex auto-resume: ${recovering ? wait : "idle"} | ` +
						`consecutive retries: ${consecutiveResumes} | current model: ${current}`,
					"info",
				);
				return;
			}
			ctx.ui.notify("Usage: /codex-resume status", "warning");
		},
	});
}
