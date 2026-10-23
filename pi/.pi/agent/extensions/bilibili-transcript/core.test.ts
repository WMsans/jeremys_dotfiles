/**
 * Tests for bilibili-transcript core (pure logic, no pi imports).
 * Run with: node --test agent/extensions/bilibili-transcript/core.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile, unlink } from "node:fs/promises";
import { formatTranscript, mergeCues, mixinKey, parseVideoInput, pickTrack, signWbi, spillTranscript, stamp } from "./core.ts";

test("parseVideoInput reads BV ids from urls, ?p= and bare ids", async () => {
	assert.deepEqual(await parseVideoInput("https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333&p=3"), {
		bvid: "BV1GJ411x7h7",
		page: 3,
	});
	assert.deepEqual(await parseVideoInput("BV1GJ411x7h7"), { bvid: "BV1GJ411x7h7", page: undefined });
	assert.deepEqual(await parseVideoInput("https://www.bilibili.com/video/av80433022"), { aid: 80433022, page: undefined });
	assert.deepEqual(await parseVideoInput("av80433022"), { aid: 80433022, page: undefined });
	await assert.rejects(() => parseVideoInput("https://example.com/video/BV1GJ411x7h7"), /Not a bilibili link/);
	await assert.rejects(() => parseVideoInput("no id here"), /Could not find a BV/);
});

test("mixinKey reorders and truncates to 32 chars", () => {
	const src = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ#$";
	const key = mixinKey(src);
	assert.equal(key.length, 32);
	assert.match(key, /^[0-9a-zA-Z#$]{32}$/);
	assert.equal(new Set(key).size, 32);
});

test("signWbi sorts keys, adds wts, strips !'()* and is deterministic", () => {
	const a = signWbi({ cid: 137649199, bvid: "BV1GJ411x7h7", empty: undefined }, "mixin", 1700000000);
	const b = signWbi({ bvid: "BV1GJ411x7h7", cid: 137649199 }, "mixin", 1700000000);
	assert.deepEqual(a, b);
	assert.equal(a.wts, 1700000000);
	assert.match(String(a.w_rid), /^[0-9a-f]{32}$/);
	assert.equal("empty" in a, false);
	// value filtering must match bilibili's rule: !'()* removed before hashing
	assert.notEqual(signWbi({ q: "a!b" }, "m", 1).w_rid, signWbi({ q: "a" }, "m", 1).w_rid);
	assert.equal(signWbi({ q: "a!()*b" }, "m", 1).w_rid, signWbi({ q: "ab" }, "m", 1).w_rid);
});

test("pickTrack prefers Chinese, honours an explicit lang, lists alternatives", () => {
	const tracks = [
		{ lan: "en-US", lan_doc: "English" },
		{ lan: "zh-CN", lan_doc: "中文（中国）" },
		{ lan: "ja", lan_doc: "日本語" },
	];
	assert.equal(pickTrack(tracks).lan, "zh-CN");
	assert.equal(pickTrack(tracks, "ja").lan, "ja");
	assert.equal(pickTrack(tracks, "EN-us").lan, "en-US");
	assert.throws(() => pickTrack(tracks, "de-DE"), /Available: en-US/);
	assert.equal(pickTrack([{ lan: "ko" }, { lan: "zh-Hant" }]).lan, "zh-Hant");
});

test("mergeCues groups short cues, spaces latin text, no space for CJK", () => {
	const blocks = mergeCues([
		{ from: 0, content: " hello " },
		{ from: 2, content: "world" },
		{ from: 3, content: "你好" },
		{ from: 4, content: "世界" },
		{ from: 10, content: "" },
		{ from: 200, content: "later" },
	]);
	assert.deepEqual(blocks, [
		{ start: 0, text: "hello world你好世界" },
		{ start: 200, text: "later" },
	]);
	assert.equal(mergeCues([{ from: 0, content: "aaaa" }, { from: 1, content: "bbbb" }], 45, 4).length, 2);
	assert.equal(mergeCues([{ from: 0, content: "a" }, { from: 120, content: "b" }]).length, 2);
});

test("stamp and formatTranscript produce a readable header", () => {
	assert.equal(stamp(0), "00:00");
	assert.equal(stamp(83.9), "01:23");
	assert.equal(stamp(3725), "1:02:05");
	const text = formatTranscript(
		{
			bvid: "BV1GJ411x7h7",
			cid: 137649199,
			page: 2,
			pages: 3,
			part: "Never Gonna Give You Up",
			duration: 213,
			lang: "zh-Hans",
			langDoc: "中文（简体）",
			cues: 2,
			tracks: ["zh-Hans", "en-US"],
		},
		[{ from: 18.55, content: "我们对爱情并不陌生" }],
	);
	assert.match(text, /^# Never Gonna Give You Up \(P2\/3\)/);
	assert.match(text, /BV1GJ411x7h7 · cid 137649199 · 时长 03:33 · 中文（简体） \(zh-Hans\) · 2 条字幕/);
	assert.match(text, /\[00:18\] 我们对爱情并不陌生/);
});

test("spillTranscript writes the full text and returns a bounded head", async () => {
	const text = "x".repeat(500);
	const meta = { bvid: "BV1GJ411x7h7", cid: 1, page: 1, pages: 1, part: "p", duration: 1, lang: "zh-Hans", langDoc: "", cues: 1, tracks: [] };
	const { head, filePath } = await spillTranscript(text, meta, 100);
	assert.equal(head.length, 100);
	assert.match(filePath, /bilibili-transcript\/BV1GJ411x7h7-p1-zh-Hans\.md$/);
	assert.equal(await readFile(filePath, "utf8"), text);
	await unlink(filePath);
});
