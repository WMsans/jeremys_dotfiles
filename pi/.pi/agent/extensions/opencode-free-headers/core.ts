/**
 * Pure logic for the opencode-free-headers extension.
 * No pi imports — unit-testable in isolation.
 */

import { createHash } from "node:crypto";
import { OPENCODE_TOOLS } from "./tools.ts";

/**
 * The OpenCode client release to impersonate. The free-tier gate reads the
 * client identity from User-Agent and rejects other shapes, so the format
 * matters: `opencode/<channel>/<version>/cli`.
 */
export const OPENCODE_CLIENT_VERSION = "2.0.29";
export const DEFAULT_OPENCODE_UA = `opencode/latest/${OPENCODE_CLIENT_VERSION}/cli`;

/** Header names the gate reads. Casing matches pi's own API layers. */
export const USER_AGENT_HEADER = "User-Agent";
export const SESSION_HEADER = "x-opencode-session";
export const SESSION_ID_HEADER = "x-opencode-session-id";
export const PROJECT_HEADER = "x-opencode-project";
export const CLIENT_HEADER = "x-opencode-client";
export const REQUEST_HEADER = "x-opencode-request";

/** Structural subset of pi's Model that identity routing depends on. */
export interface IdentityModel {
	provider?: string;
	id?: string;
	baseUrl?: string;
	api?: string;
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

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function base62(bytes: Buffer, length: number): string {
	let out = "";
	for (let i = 0; i < length; i++) out += BASE62[bytes[i % bytes.length] % 62];
	return out;
}

/**
 * System-prompt section re-exposing pi's real tool shapes. The outgoing request
 * declares a reduced, OpenCode-shaped tool set to pass the free-tier gate, so
 * the wire schema for `read` marks offset/limit optional and `edit` is absent.
 * Pi still executes its own tools, so tell the model how to call them.
 */
export const OPENCODE_TOOL_GUIDANCE = [
	"### OpenCode free-tier tool notes",
	"The provider request declares a reduced tool list to satisfy OpenCode's gateway. Every tool you normally have stays callable; use these argument shapes (the request schema may differ):",
	"- `read`: always send `path`, `offset`, and `limit` (use `null` for `offset` to start at line 1, and `null` for `limit` for the whole file).",
	"- `edit`: send `path` and `edits: [{ oldText, newText }]`.",
	"- `write`: send `path` and `content`.",
	"- `shell`: alias of `bash`; send `command` (optional `timeout` in milliseconds).",
].join("\n");

/**
 * Build the session id the gate accepts. The 12 hex digits are the OpenCode
 * client's `Identifier.descending()` encoding — `~(ts<<12 | counter)` — and the
 * gate validates that low 12 bits fall in 0xFC0–0xFFF, i.e. counter 1–63.
 * A hash-derived timestamp with counter 1 keeps the id stable per conversation
 * and always yields the `ffe` suffix that passes.
 */
export function deriveOpencodeSession(seed: string | undefined | null): string {
	const digest = createHash("sha256").update(`ses\0${seed ?? ""}`).digest();
	// 36 hash bits as the timestamp, counter 1, then bitwise NOT (low 12 = 0xFFE).
	const stamp = ((BigInt(digest[0]) << 32n) | BigInt(digest.readUInt32BE(1))) & 0xfffffffffn;
	const inverted = ~((stamp << 12n) | 1n) & 0xffffffffffffn;
	return `ses_${inverted.toString(16).padStart(12, "0")}${base62(digest.subarray(6, 20), 14)}`;
}

/** Bare 40-character hex project id, derived stably from the session seed. */
export function deriveOpencodeProject(seed: string | undefined | null): string {
	return createHash("sha256").update(`prj\0${seed ?? ""}`).digest("hex").slice(0, 40);
}

/**
 * Stamp the opencode identity onto outgoing headers, in place.
 * Any case-variant of these headers is removed first so we cannot end up
 * sending both pi's value and ours in the same request. `x-opencode-request`
 * is deliberately removed: the gate now rejects it.
 */
export function applyOpencodeIdentity(
	headers: Record<string, string | null>,
	userAgent: string = DEFAULT_OPENCODE_UA,
	sessionSeed?: string,
): void {
	const owned = [
		USER_AGENT_HEADER,
		SESSION_HEADER,
		SESSION_ID_HEADER,
		PROJECT_HEADER,
		CLIENT_HEADER,
		REQUEST_HEADER,
	].map((name) => name.toLowerCase());
	for (const name of Object.keys(headers)) {
		if (owned.includes(name.toLowerCase())) delete headers[name];
	}
	const session = deriveOpencodeSession(sessionSeed);
	headers[USER_AGENT_HEADER] = userAgent;
	headers[CLIENT_HEADER] = "cli";
	headers[SESSION_HEADER] = session;
	headers[SESSION_ID_HEADER] = session;
	headers[PROJECT_HEADER] = deriveOpencodeProject(sessionSeed);
}

/**
 * Every tool name the free-tier gate recognises. Names outside this set pass
 * through; a recognised name must carry its genuine definition, so any we do
 * not ship a genuine copy of is dropped rather than sent as a stub.
 */
const RECOGNIZED_TOOLS = new Set([
	"bash",
	"edit",
	"execute",
	"glob",
	"grep",
	"question",
	"read",
	"shell",
	"skill",
	"subagent",
	"webfetch",
	"websearch",
	"write",
]);

function toolName(entry: unknown, flat: boolean): string {
	if (!entry || typeof entry !== "object") return "";
	const record = entry as Record<string, unknown>;
	if (flat) return typeof record.name === "string" ? record.name : "";
	const fn = record.function as Record<string, unknown> | undefined;
	return typeof fn?.name === "string" ? fn.name : "";
}

/** Render one genuine definition in the shape the wire protocol expects. */
export function renderGenuineTool(name: string, flat: boolean): unknown {
	const definition = OPENCODE_TOOLS[name];
	const body = { description: definition.description, parameters: definition.parameters };
	return flat ? { type: "function", name, ...body } : { type: "function", function: { name, ...body } };
}

/**
 * Make the outgoing tool list read as an agent session the free-tier gate
 * accepts: genuine `shell` and `read` must be present, every other recognised
 * name must carry its genuine definition, and names pi cannot run are dropped.
 * Unknown tool names pass through untouched so downstream calls keep working.
 */
export function rewriteOpencodeTools(tools: unknown, flat: boolean): unknown[] {
	const input = Array.isArray(tools) ? tools : [];
	const out: unknown[] = [];
	const present = new Set<string>();
	for (const entry of input) {
		const name = toolName(entry, flat);
		if (OPENCODE_TOOLS[name]) {
			out.push(renderGenuineTool(name, flat));
			present.add(name);
			continue;
		}
		// Recognised by upstream but no usable genuine definition: bash has none,
		// and pi's edit/question/subagent schemas differ from OpenCode's.
		if (RECOGNIZED_TOOLS.has(name)) continue;
		out.push(entry);
	}
	if (!present.has("shell")) out.push(renderGenuineTool("shell", flat));
	if (!present.has("read")) out.push(renderGenuineTool("read", flat));
	return out;
}
