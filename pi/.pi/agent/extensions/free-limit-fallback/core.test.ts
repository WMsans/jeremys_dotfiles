/**
 * Tests for free-limit-fallback-core.ts (pure logic, no pi imports).
 * Run with: node --test agent/extensions/free-limit-fallback-core.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
	DEFAULT_CONFIG,
	detectFreeUsageLimit,
	isValidFallback,
	nextFallback,
	splitFallback,
} from "./core.ts";

// ---------------------------------------------------------------------------
// detectFreeUsageLimit
// ---------------------------------------------------------------------------

test("detectFreeUsageLimit matches the exact opencode Console 429 message", () => {
	const msg =
		'Error: OpenAI API error (429): {"type":"FreeUsageLimitError","message":"Error from provider (Console): Rate limit exceeded. Please try\n again later."}';
	assert.equal(detectFreeUsageLimit(msg), true);
});

test("detectFreeUsageLimit does not match GoUsageLimitError", () => {
	const msg =
		'Error: 429: {"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 1hr 19min."}';
	assert.equal(detectFreeUsageLimit(msg), false);
});

test("detectFreeUsageLimit does not match plain 429 rate limits", () => {
	assert.equal(detectFreeUsageLimit("Error: OpenAI API error (429): rate limit exceeded"), false);
	assert.equal(detectFreeUsageLimit("429 Too Many Requests"), false);
});

test("detectFreeUsageLimit does not match other HTTP errors", () => {
	assert.equal(detectFreeUsageLimit("Error: OpenAI API error (500): server exploded"), false);
	assert.equal(detectFreeUsageLimit("Error: OpenAI API error (401): bad key"), false);
});

test("detectFreeUsageLimit does not match abort messages (manual stop)", () => {
	assert.equal(detectFreeUsageLimit("This operation was aborted"), false);
	assert.equal(detectFreeUsageLimit("AbortError: The operation was aborted."), false);
});

test("detectFreeUsageLimit is false for undefined/empty", () => {
	assert.equal(detectFreeUsageLimit(undefined), false);
	assert.equal(detectFreeUsageLimit(null), false);
	assert.equal(detectFreeUsageLimit(""), false);
});

// ---------------------------------------------------------------------------
// splitFallback / isValidFallback
// ---------------------------------------------------------------------------

test("splitFallback splits provider/model", () => {
	assert.deepEqual(splitFallback("opencode-go/deepseek-v4-flash"), {
		provider: "opencode-go",
		modelId: "deepseek-v4-flash",
	});
});

test("splitFallback trims whitespace", () => {
	assert.deepEqual(splitFallback("  deepseek / deepseek-v4-pro  "), {
		provider: "deepseek",
		modelId: "deepseek-v4-pro",
	});
});

test("splitFallback handles bare model ids", () => {
	assert.deepEqual(splitFallback("gpt-5.6-luna"), { provider: "", modelId: "gpt-5.6-luna" });
});

test("isValidFallback requires provider and model", () => {
	assert.equal(isValidFallback("opencode-go/deepseek-v4-flash"), true);
	assert.equal(isValidFallback("gpt-5.6-luna"), false);
	assert.equal(isValidFallback(""), false);
	assert.equal(isValidFallback("/"), false);
	assert.equal(isValidFallback("deepseek/"), false);
});

// ---------------------------------------------------------------------------
// nextFallback — list rotation
// ---------------------------------------------------------------------------

const LIST = ["opencode-go/deepseek-v4-flash", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"];

test("nextFallback returns null for an empty list", () => {
	assert.equal(nextFallback([], "opencode", "claude-sonnet-5"), null);
	assert.equal(nextFallback(undefined, "opencode", "claude-sonnet-5"), null);
});

test("nextFallback starts at index 0 when current model is not in the list", () => {
	assert.equal(nextFallback(LIST, "opencode", "claude-sonnet-5"), LIST[0]);
});

test("nextFallback advances to the next entry when current model is in the list", () => {
	assert.equal(nextFallback(LIST, "opencode-go", "deepseek-v4-flash"), LIST[1]);
	assert.equal(nextFallback(LIST, "deepseek", "deepseek-v4-flash"), LIST[2]);
});

test("nextFallback returns null at the end of the list (round exhausted)", () => {
	assert.equal(nextFallback(LIST, "deepseek", "deepseek-v4-pro"), null);
});

test("nextFallback matches bare model id as well as provider/id", () => {
	assert.equal(nextFallback(LIST, "opencode-go", "deepseek-v4-flash"), LIST[1]);
	assert.equal(nextFallback(LIST, "whatever", "deepseek-v4-flash"), LIST[1]);
});

test("nextFallback falls back to index 0 for models outside the list even mid-session", () => {
	assert.equal(nextFallback(LIST, "anthropic", "claude-sonnet-4-5"), LIST[0]);
});

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

test("defaults are safe: disabled, empty list", () => {
	assert.equal(DEFAULT_CONFIG.enabled, false);
	assert.deepEqual(DEFAULT_CONFIG.fallbacks, []);
	assert.ok(DEFAULT_CONFIG.maxRounds >= 1);
	assert.ok(DEFAULT_CONFIG.roundBackoffMs >= 0);
});
