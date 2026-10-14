/**
 * Tests for opencode-free-headers/core.ts (pure logic, no pi imports).
 * Run with: node --test ~/.pi/agent/extensions/opencode-free-headers/core.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
	DEFAULT_OPENCODE_UA,
	applyOpencodeIdentity,
	deriveOpencodeProject,
	deriveOpencodeSession,
	isOpencodeModel,
	resolveUserAgent,
	rewriteOpencodeTools,
} from "./core.ts";
import { OPENCODE_TOOLS } from "./tools.ts";

// ---------------------------------------------------------------------------
// isOpencodeModel
// ---------------------------------------------------------------------------

test("isOpencodeModel matches the opencode providers", () => {
	assert.equal(isOpencodeModel({ provider: "opencode", id: "space-bunny-free" }), true);
	assert.equal(isOpencodeModel({ provider: "opencode-go", id: "deepseek-v4-flash" }), true);
});

test("isOpencodeModel matches by opencode.ai baseUrl regardless of provider id", () => {
	assert.equal(isOpencodeModel({ provider: "custom", baseUrl: "https://opencode.ai/inference/v1" }), true);
});

test("isOpencodeModel leaves every other provider alone", () => {
	assert.equal(isOpencodeModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }), false);
	assert.equal(isOpencodeModel({ provider: "deepseek", baseUrl: "https://api.deepseek.com" }), false);
	// A lookalike host must not match.
	assert.equal(isOpencodeModel({ provider: "proxy", baseUrl: "https://opencode.ai.evil.test/v1" }), false);
	assert.equal(isOpencodeModel(undefined), false);
	assert.equal(isOpencodeModel({}), false);
	assert.equal(isOpencodeModel({ baseUrl: "not a url" }), false);
});

// ---------------------------------------------------------------------------
// resolveUserAgent
// ---------------------------------------------------------------------------

test("resolveUserAgent prefers an override and falls back to the client shape", () => {
	assert.equal(resolveUserAgent("opencode/latest/9.9.9/cli"), "opencode/latest/9.9.9/cli");
	assert.equal(resolveUserAgent("  opencode/latest/9.9.9/cli  "), "opencode/latest/9.9.9/cli");
	assert.equal(resolveUserAgent(undefined), DEFAULT_OPENCODE_UA);
	assert.equal(resolveUserAgent(""), DEFAULT_OPENCODE_UA);
	assert.equal(resolveUserAgent("   "), DEFAULT_OPENCODE_UA);
	assert.match(DEFAULT_OPENCODE_UA, /^opencode\/[^/]+\/[^/]+\/[^/]+$/);
});

// ---------------------------------------------------------------------------
// session + project ids
// ---------------------------------------------------------------------------

test("deriveOpencodeSession emits the descending ses_ shape the gate accepts", () => {
	const id = deriveOpencodeSession("01a0ade4-78cb-749c-ae2a-0fe0805f8385");
	assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	// Low 12 bits must be 0xFFF - counter with counter in 1..63.
	const low12 = Number.parseInt(id.slice(13, 16), 16);
	assert.ok(low12 >= 0xfc0 && low12 <= 0xfff, `low 12 bits ${low12.toString(16)} outside 0xfc0-0xfff`);
});

test("deriveOpencodeSession is stable for one session and distinct across sessions", () => {
	assert.equal(deriveOpencodeSession("session-a"), deriveOpencodeSession("session-a"));
	assert.notEqual(deriveOpencodeSession("session-a"), deriveOpencodeSession("session-b"));
	assert.ok(!deriveOpencodeSession("session-a").includes("session-a"));
	assert.match(deriveOpencodeSession(undefined), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

test("deriveOpencodeProject is a stable bare 40-hex id", () => {
	assert.match(deriveOpencodeProject("session-a"), /^[0-9a-f]{40}$/);
	assert.equal(deriveOpencodeProject("session-a"), deriveOpencodeProject("session-a"));
	assert.notEqual(deriveOpencodeProject("session-a"), deriveOpencodeProject("session-b"));
});

// ---------------------------------------------------------------------------
// applyOpencodeIdentity
// ---------------------------------------------------------------------------

test("applyOpencodeIdentity writes the current client header set", () => {
	const headers: Record<string, string | null> = {
		"User-Agent": "pi (darwin 25.0.0; arm64)",
		"x-opencode-session": "01a0ade4-78cb-749c-ae2a-0fe0805f8385",
		"x-opencode-request": "msg_legacy",
		"x-opencode-client": "pi",
		authorization: "Bearer sk-secret",
	};
	applyOpencodeIdentity(headers, DEFAULT_OPENCODE_UA, "01a0ade4-78cb-749c-ae2a-0fe0805f8385");

	assert.equal(headers["User-Agent"], DEFAULT_OPENCODE_UA);
	assert.equal(headers["x-opencode-client"], "cli");
	assert.match(String(headers["x-opencode-session"]), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	assert.equal(headers["x-opencode-session-id"], headers["x-opencode-session"]);
	assert.match(String(headers["x-opencode-project"]), /^[0-9a-f]{40}$/);
	// The gate rejects the legacy request header, and the real API key survives.
	assert.equal(headers["x-opencode-request"], undefined);
	assert.equal(headers.authorization, "Bearer sk-secret");
});

test("applyOpencodeIdentity collapses case-variants to one header each", () => {
	const headers: Record<string, string | null> = {
		"user-agent": "pi",
		"USER-AGENT": "pi",
		"X-OpenCode-Session": "uuid",
		"X-OpenCode-Project": "prj_legacy",
	};
	applyOpencodeIdentity(headers, "opencode/latest/1.2.3/cli", "seed");
	assert.deepEqual(Object.keys(headers).sort(), [
		"User-Agent",
		"x-opencode-client",
		"x-opencode-project",
		"x-opencode-session",
		"x-opencode-session-id",
	]);
});

// ---------------------------------------------------------------------------
// rewriteOpencodeTools — the fingerprint body
// ---------------------------------------------------------------------------

function chatTools(tools: unknown[]): Array<Record<string, any>> {
	const out = rewriteOpencodeTools(tools, false) as Array<Record<string, any>>;
	for (const entry of out) {
		assert.equal(entry.type, "function");
		assert.ok(entry.function, "chat tools must be nested under function");
	}
	return out;
}

test("rewriteOpencodeTools drops bash/edit and genuine-izes read/write", () => {
	const piTools = [
		{ type: "function", function: { name: "read", description: "pi read", parameters: { type: "object" } } },
		{ type: "function", function: { name: "bash", description: "pi bash", parameters: { type: "object" } } },
		{ type: "function", function: { name: "edit", description: "pi edit", parameters: { type: "object" } } },
		{ type: "function", function: { name: "write", description: "pi write", parameters: { type: "object" } } },
		{ type: "function", function: { name: "subagent", description: "pi subagent", parameters: { type: "object" } } },
		{ type: "function", function: { name: "webfetch", description: "pi webfetch", parameters: { type: "object" } } },
		{ type: "function", function: { name: "my_custom", description: "keep me", parameters: { type: "object" } } },
	];
	const out = chatTools(piTools);
	const names = out.map((entry) => entry.function.name);
	assert.deepEqual(names.slice().sort(), ["my_custom", "read", "shell", "write"]);
	const byName = new Map(out.map((entry) => [entry.function.name, entry.function]));
	assert.equal(byName.get("read")!.description, OPENCODE_TOOLS.read.description);
	assert.equal(byName.get("write")!.description, OPENCODE_TOOLS.write.description);
	assert.equal(byName.get("shell")!.description, OPENCODE_TOOLS.shell.description);
	assert.equal(byName.get("my_custom")!.description, "keep me");
});

test("rewriteOpencodeTools emits flat tools for the Responses API", () => {
	const out = rewriteOpencodeTools([{ type: "function", name: "read", description: "pi", parameters: {} }], true) as Array<
		Record<string, any>
	>;
	for (const entry of out) {
		assert.equal(entry.type, "function");
		assert.equal(entry.function, undefined);
		assert.equal(entry.description.length > 0, true);
	}
	const names = out.map((entry) => entry.name).sort();
	assert.deepEqual(names, ["read", "shell"]);
});

test("rewriteOpencodeTools injects the required quartet on tool-less requests", () => {
	const names = chatTools([]).map((entry) => entry.function.name).sort();
	assert.deepEqual(names, ["read", "shell"]);
});
