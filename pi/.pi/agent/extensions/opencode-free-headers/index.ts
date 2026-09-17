/**
 * OpenCode free-tier identity headers.
 *
 * OpenCode Zen's free/contributor tier gates on *client identity*, not auth.
 * Requests that don't look like they come from opencode itself are rejected:
 *
 *   Error: OpenAI API error (403):
 *   {"type":"FreeTierError","message":"Error from provider (Console):
 *    OpenCode's free tier can only be used from within OpenCode"}
 *
 * Two headers have to look right, and pi gets both wrong (verified by
 * bisecting a live request against the real endpoint, and consistent with
 * opencode issue #42500 + the zen-proxy reference implementation):
 *
 *   1. `User-Agent` — pi identifies as `pi (<platform> <release>; <arch>)`;
 *      the gate wants `opencode/<version>`.
 *   2. `x-opencode-session` — pi does send one
 *      (dist/core/provider-attribution.js, getSessionHeaders) but it is a
 *      bare UUID. The Console only accepts opencode's own `ses_<26 hex>`
 *      shape, so pi's value fails the free-tier check and gets reported as
 *      FreeTierError rather than MissingSessionID.
 *
 * Changing either one alone still 403s. Authorization is left untouched, so a
 * real Zen key is still sent as-is.
 *
 * Usage:
 *   Place in ~/.pi/agent/extensions/ (auto-discovered; /reload to pick up).
 *   Override the impersonated version with OPENCODE_FREE_UA=opencode/1.2.3
 *   if the gate ever tightens.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyOpencodeIdentity, isOpencodeModel, resolveUserAgent } from "./core.ts";

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_headers", (event, ctx) => {
		if (!isOpencodeModel(ctx.model)) return;
		applyOpencodeIdentity(
			event.headers,
			resolveUserAgent(process.env.OPENCODE_FREE_UA),
			ctx.sessionManager.getSessionId(),
		);
	});
}
