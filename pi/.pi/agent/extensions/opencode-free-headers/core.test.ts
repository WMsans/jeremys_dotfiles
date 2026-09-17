/**
 * Tests for opencode-free-headers/core.ts (pure logic, no pi imports).
 * Run with: node --test ~/.pi/agent/extensions/opencode-free-headers/core.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
	DEFAULT_OPENCODE_UA,
	applyOpencodeIdentity,
	deriveOpencodeSession,
	isOpencodeModel,
	resolveUserAgent,
} from "./core.ts";

// ---------------------------------------------------------------------------
// isOpencodeModel
// ---------------------------------------------------------------------------

test("isOpencodeModel matches the opencode providers", () => {
	assert.equal(isOpencodeModel({ provider: "opencode", id: "muse-spark-1.3-contributor-free" }), true);
	assert.equal(isOpencodeModel({ provider: "opencode-go", id: "deepseek-v4-flash" }), true);
});

test("isOpencodeModel matches by opencode.ai baseUrl regardless of provider id", () => {
	assert.equal(isOpencodeModel({ provider: "custom", baseUrl: "https://opencode.ai/zen/v1" }), true);
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

test("resolveUserAgent prefers an override and falls back to the default", () => {
	assert.equal(resolveUserAgent("opencode/9.9.9"), "opencode/9.9.9");
	assert.equal(resolveUserAgent("  opencode/9.9.9  "), "opencode/9.9.9");
	assert.equal(resolveUserAgent(undefined), DEFAULT_OPENCODE_UA);
	assert.equal(resolveUserAgent(""), DEFAULT_OPENCODE_UA);
	assert.equal(resolveUserAgent("   "), DEFAULT_OPENCODE_UA);
});

// ---------------------------------------------------------------------------
// deriveOpencodeSession — the Console only accepts opencode's own id shape
// ---------------------------------------------------------------------------

test("deriveOpencodeSession emits the ses_<26 hex> shape the gate accepts", () => {
	const id = deriveOpencodeSession("01a0ade4-78cb-749c-ae2a-0fe0805f8385");
	assert.match(id, /^ses_[0-9a-f]{26}$/);
});

test("deriveOpencodeSession is stable for one session and distinct across sessions", () => {
	assert.equal(deriveOpencodeSession("session-a"), deriveOpencodeSession("session-a"));
	assert.notEqual(deriveOpencodeSession("session-a"), deriveOpencodeSession("session-b"));
	// Never leaks the seed upstream, and never yields an empty value.
	assert.ok(!deriveOpencodeSession("session-a").includes("session-a"));
	assert.match(deriveOpencodeSession(undefined), /^ses_[0-9a-f]{26}$/);
});

// ---------------------------------------------------------------------------
// applyOpencodeIdentity — the actual fix
// ---------------------------------------------------------------------------

test("applyOpencodeIdentity fixes both gated headers and leaves the rest alone", () => {
	const headers: Record<string, string | null> = {
		"User-Agent": "pi (darwin 25.0.0; arm64)",
		"x-opencode-session": "01a0ade4-78cb-749c-ae2a-0fe0805f8385",
		"x-opencode-client": "pi",
		authorization: "Bearer sk-secret",
	};
	applyOpencodeIdentity(headers, DEFAULT_OPENCODE_UA, "01a0ade4-78cb-749c-ae2a-0fe0805f8385");

	assert.equal(headers["User-Agent"], DEFAULT_OPENCODE_UA);
	assert.match(String(headers["x-opencode-session"]), /^ses_[0-9a-f]{26}$/);
	// pi's other headers and the real API key survive untouched.
	assert.equal(headers["x-opencode-client"], "pi");
	assert.equal(headers.authorization, "Bearer sk-secret");
});

test("applyOpencodeIdentity collapses case-variants to one header each", () => {
	const headers: Record<string, string | null> = {
		"user-agent": "pi (darwin 25.0.0; arm64)",
		"USER-AGENT": "pi",
		"X-OpenCode-Session": "uuid",
	};
	applyOpencodeIdentity(headers, "opencode/1.2.3", "seed");
	assert.deepEqual(Object.keys(headers).sort(), ["User-Agent", "x-opencode-session"]);
	assert.equal(headers["User-Agent"], "opencode/1.2.3");
});

test("applyOpencodeIdentity works on empty headers", () => {
	const headers: Record<string, string | null> = {};
	applyOpencodeIdentity(headers, undefined, "seed");
	assert.match(String(headers["User-Agent"]), /^opencode\//);
	assert.match(String(headers["x-opencode-session"]), /^ses_/);
});
