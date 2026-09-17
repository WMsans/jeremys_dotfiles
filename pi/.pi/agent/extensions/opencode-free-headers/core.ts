/**
 * Pure logic for the opencode-free-headers extension.
 * No pi imports — unit-testable in isolation.
 */

import { createHash } from "node:crypto";

/**
 * The opencode client version to impersonate. The free tier's gate reads the
 * User-Agent, so a plausible `opencode/<version>` is what matters, not the
 * exact build. Overridable via OPENCODE_FREE_UA when opencode ships a new
 * version and the gate moves on.
 */
export const DEFAULT_OPENCODE_UA = "opencode/1.18.30";

/** Header names the gate reads. Casing matches pi's own API layers. */
export const USER_AGENT_HEADER = "User-Agent";
export const SESSION_HEADER = "x-opencode-session";

/** Structural subset of pi's Model that identity routing depends on. */
export interface IdentityModel {
	provider?: string;
	id?: string;
	baseUrl?: string;
}

/**
 * True for requests routed to opencode (Zen and Go).
 * Mirrors pi's own predicate in dist/core/provider-attribution.js
 * (getSessionHeaders), so these headers travel with the session header pi
 * already sends for exactly these requests.
 */
export function isOpencodeModel(model: IdentityModel | undefined | null): boolean {
	if (!model) return false;
	if (model.provider === "opencode" || model.provider === "opencode-go") return true;
	try {
		return new URL(model.baseUrl ?? "").hostname === "opencode.ai";
	} catch {
		return false;
	}
}

/** Resolve the User-Agent to send: explicit override, else the default. */
export function resolveUserAgent(raw: string | undefined | null): string {
	const trimmed = (raw ?? "").trim();
	return trimmed.length > 0 ? trimmed : DEFAULT_OPENCODE_UA;
}

/**
 * Build the session id the gate accepts. opencode session ids look like
 * `ses_<26 hex>`; pi sends a plain UUID, which the Console rejects with
 * FreeTierError. Derived by hashing the pi session id so it stays identical
 * for every request in a session (opencode treats it as one conversation)
 * without leaking pi's own id upstream.
 */
export function deriveOpencodeSession(seed: string | undefined | null): string {
	const digest = createHash("sha256").update(seed ?? "").digest("hex");
	return `ses_${digest.slice(0, 26)}`;
}

/**
 * Stamp the opencode identity onto outgoing headers, in place.
 * Any case-variant of these headers is removed first so we cannot end up
 * sending both pi's value and ours in the same request.
 */
export function applyOpencodeIdentity(
	headers: Record<string, string | null>,
	userAgent: string = DEFAULT_OPENCODE_UA,
	sessionId?: string,
): void {
	const owned = [USER_AGENT_HEADER.toLowerCase(), SESSION_HEADER.toLowerCase()];
	for (const name of Object.keys(headers)) {
		if (owned.includes(name.toLowerCase())) delete headers[name];
	}
	headers[USER_AGENT_HEADER] = userAgent;
	headers[SESSION_HEADER] = deriveOpencodeSession(sessionId);
}
