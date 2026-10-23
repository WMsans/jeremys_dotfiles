/**
 * Bilibili video transcript (subtitle) fetching.
 *
 * Flow, same as the biu desktop app:
 *   x/player/pagelist  -> cid + part title
 *   x/web-interface/nav -> wbi img/sub keys (works logged out too)
 *   x/player/wbi/v2    -> subtitle.subtitles[] (needs a logged-in cookie)
 *   subtitle_url       -> { body: [{ from, content }] } JSON
 *
 * Cookie sources, first hit wins:
 *   BILI_COOKIE / BILI_SESSDATA env, ~/.pi/agent/bilibili-cookie.txt,
 *   then the biu app's Chromium cookie DB (plaintext `value` column).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.bilibili.com";
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, Referer: "https://www.bilibili.com/" };
const TIMEOUT_MS = 20_000;

const COOKIE_FILE = join(homedir(), ".pi", "agent", "bilibili-cookie.txt");

const MIXIN_TAB = [
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
	13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
	44, 52,
];

export interface VideoRef {
	bvid?: string;
	aid?: number;
	page?: number;
}

export interface TranscriptMeta {
	bvid?: string;
	aid?: number;
	cid: number;
	page: number;
	pages: number;
	part: string;
	duration: number;
	lang: string;
	langDoc: string;
	cues: number;
	tracks: string[];
}

export interface Transcript {
	text: string;
	meta: TranscriptMeta;
}

interface BiliResponse<T> {
	code: number;
	message: string;
	data?: T;
}

interface Page {
	cid: number;
	page: number;
	part: string;
	duration: number;
}

interface SubtitleTrack {
	lan?: string;
	lan_doc?: string;
	subtitle_url?: string;
	subtitle_url_v2?: string;
}

interface Cue {
	from?: number;
	content?: string;
}

// --- input parsing -------------------------------------------------------

/** Parse a bilibili URL, BV id, or av id. b23.tv links are expanded. */
export async function parseVideoInput(input: string, signal?: AbortSignal): Promise<VideoRef> {
	let s = input.trim();
	if (!s) throw new Error("Empty bilibili input");
	let page: number | undefined;

	if (/^https?:\/\//i.test(s)) {
		let url = new URL(s);
		if (/^(www\.)?b23\.tv$/i.test(url.hostname)) {
			const res = await fetch(s, { headers: HEADERS, signal: withTimeout(signal) });
			url = new URL(res.url);
		} else if (!/(^|\.)bilibili\.com$/i.test(url.hostname)) {
			throw new Error(`Not a bilibili link: ${url.hostname}`);
		}
		const p = Number(url.searchParams.get("p"));
		if (Number.isInteger(p) && p > 0) page = p;
		s = url.pathname;
	}

	const bv = s.match(/BV[0-9A-Za-z]{10}/);
	if (bv) return { bvid: bv[0], page };

	const av = s.match(/av(\d+)/i);
	if (av) return { aid: Number(av[1]), page };

	if (/^\d+$/.test(s)) return { aid: Number(s), page };

	throw new Error(`Could not find a BV/av id in: ${input}`);
}

// --- wbi signing ---------------------------------------------------------

export function mixinKey(orig: string): string {
	return MIXIN_TAB.map((n) => orig[n])
		.join("")
		.slice(0, 32);
}

export function signWbi(
	params: Record<string, string | number | undefined>,
	mixin: string,
	now: number = Math.round(Date.now() / 1000),
): Record<string, string | number> {
	const withTime: Record<string, string | number> = { wts: now };
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null && v !== "") withTime[k] = v;
	}
	const query = Object.keys(withTime)
		.sort()
		.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(withTime[k]).replace(/[!'()*]/g, ""))}`)
		.join("&");
	const w_rid = createHash("md5").update(query + mixin).digest("hex");
	return { ...withTime, w_rid };
}

// Keyed by "auth"/"anon": a cached anonymous nav response must never be reused
// for an authenticated call, or subtitles look empty despite a valid cookie.
const wbiCache = new Map<string, { mixin: string; at: number; login: boolean }>();

async function getWbi(cookie: string | null, signal?: AbortSignal): Promise<{ mixin: string; login: boolean }> {
	const slot = cookie ? "auth" : "anon";
	const cached = wbiCache.get(slot);
	if (cached && Date.now() - cached.at < 10 * 60_000) return cached;
	const nav = await getJson<{
		isLogin?: boolean;
		wbi_img?: { img_url?: string; sub_url?: string };
	}>(`${API}/x/web-interface/nav`, cookie, signal);
	const img = nav.data?.wbi_img?.img_url;
	const sub = nav.data?.wbi_img?.sub_url;
	if (!img || !sub) throw new Error("bilibili nav returned no wbi keys");
	const keyName = (u: string) => u.slice(u.lastIndexOf("/") + 1, u.lastIndexOf("."));
	const entry = { mixin: mixinKey(keyName(img) + keyName(sub)), at: Date.now(), login: Boolean(nav.data?.isLogin) };
	wbiCache.set(slot, entry);
	return entry;
}

// --- http ----------------------------------------------------------------

function withTimeout(signal?: AbortSignal): AbortSignal | undefined {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function getJson<T>(url: string, cookie: string | null, signal?: AbortSignal): Promise<BiliResponse<T>> {
	const res = await fetch(url, {
		headers: cookie ? { ...HEADERS, Cookie: cookie } : HEADERS,
		signal: withTimeout(signal),
	});
	const text = await res.text();
	let body: BiliResponse<T>;
	try {
		body = JSON.parse(text) as BiliResponse<T>;
	} catch {
		throw new Error(`bilibili returned non-JSON (HTTP ${res.status}) for ${url.replace(/\?.*$/, "")}`);
	}
	if (body.code === -412) throw new Error("bilibili risk control (-412): requests from this IP are throttled, retry later");
	return body;
}

// --- cookies -------------------------------------------------------------

function biuCookieDb(): string | null {
	if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "biu", "Cookies");
	if (process.platform === "win32") return join(process.env.APPDATA ?? "", "biu", "Cookies");
	return join(homedir(), ".config", "biu", "Cookies");
}

async function readBiuCookie(): Promise<string | null> {
	const file = biuCookieDb();
	if (!file) return null;
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(file, { readOnly: true });
		try {
			const rows = db
				.prepare("select name, value from cookies where host_key like '%bilibili%' and length(value) > 0")
				.all() as { name: string; value: string }[];
			return rows.length ? rows.map((r) => `${r.name}=${r.value}`).join("; ") : null;
		} finally {
			db.close();
		}
	} catch {
		return null;
	}
}

export async function loadCookie(): Promise<string | null> {
	if (process.env.BILI_COOKIE) return process.env.BILI_COOKIE;
	if (process.env.BILI_SESSDATA) return `SESSDATA=${process.env.BILI_SESSDATA}`;
	try {
		const raw = (await readFile(COOKIE_FILE, "utf8")).trim();
		if (raw) return raw.includes("=") ? raw : `SESSDATA=${raw}`;
	} catch {
		// no cookie file
	}
	return readBiuCookie();
}

// --- fetch ---------------------------------------------------------------

async function fetchPages(ref: VideoRef, cookie: string | null, signal?: AbortSignal): Promise<Page[]> {
	const q = ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid}`;
	const res = await getJson<Page[]>(`${API}/x/player/pagelist?${q}`, cookie, signal);
	if (res.code !== 0 || !res.data?.length) {
		throw new Error(`bilibili pagelist failed for ${ref.bvid ?? `av${ref.aid}`}: ${res.code} ${res.message}`);
	}
	return res.data;
}

async function fetchTracks(
	ref: VideoRef,
	cid: number,
	cookie: string | null,
	signal?: AbortSignal,
): Promise<SubtitleTrack[]> {
	const { mixin, login } = await getWbi(cookie, signal);
	const signed = signWbi({ bvid: ref.bvid, aid: ref.aid, cid }, mixin);
	const query = new URLSearchParams(Object.entries(signed).map(([k, v]) => [k, String(v)]));
	const res = await getJson<{ subtitle?: { subtitles?: SubtitleTrack[] } }>(
		`${API}/x/player/wbi/v2?${query}`,
		cookie,
		signal,
	);
	if (res.code !== 0) throw new Error(`bilibili player info failed: ${res.code} ${res.message}`);
	const tracks = res.data?.subtitle?.subtitles ?? [];
	if (!tracks.length) {
		if (login) throw new Error("this video has no subtitle tracks");
		throw new Error(
			`bilibili requires a logged-in account for subtitles${cookie ? " (the current cookie is not logged in and may have expired)" : ""}. Set BILI_SESSDATA (or BILI_COOKIE), write ~/.pi/agent/bilibili-cookie.txt, or log in once in the biu app.`,
		);
	}
	return tracks;
}

function normalizeUrl(url: string): string {
	return url.startsWith("//") ? `https:${url}` : url;
}

async function fetchCues(track: SubtitleTrack, signal?: AbortSignal): Promise<Cue[]> {
	const url = track.subtitle_url || track.subtitle_url_v2;
	if (!url) throw new Error("subtitle track has no url");
	const res = await fetch(normalizeUrl(url), { headers: HEADERS, signal: withTimeout(signal) });
	if (!res.ok) throw new Error(`subtitle download failed: HTTP ${res.status}`);
	const text = await res.text();
	if (!text.trimStart().startsWith("{")) {
		throw new Error("subtitle payload is not JSON (protobuf-only track), try another language");
	}
	const body = JSON.parse(text) as { body?: Cue[] };
	return body.body ?? [];
}

export function pickTrack(tracks: SubtitleTrack[], lang?: string): SubtitleTrack {
	if (!tracks.length) throw new Error("no subtitle tracks available for this video");
	if (lang) {
		const wanted = lang.toLowerCase();
		const hit = tracks.find((t) => t.lan?.toLowerCase() === wanted) ?? tracks.find((t) => t.lan?.toLowerCase().startsWith(wanted));
		if (hit) return hit;
		throw new Error(
			`no subtitle track for "${lang}". Available: ${tracks.map((t) => `${t.lan} (${t.lan_doc})`).join(", ")}`,
		);
	}
	// Prefer simplified Chinese, then any Chinese, then whatever is first.
	const byLan = (lan: string) => tracks.find((t) => t.lan === lan);
	return byLan("zh-Hans") ?? byLan("zh-CN") ?? byLan("ai-zh") ?? tracks.find((t) => t.lan?.startsWith("zh")) ?? tracks[0];
}

// --- formatting ----------------------------------------------------------

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

function joinText(a: string, b: string): string {
	if (!a) return b;
	return CJK.test(a.at(-1) ?? "") || CJK.test(b[0] ?? "") ? a + b : `${a} ${b}`;
}

export function stamp(seconds: number): string {
	const t = Math.max(0, Math.floor(seconds));
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const s = t % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Merge short cues into readable blocks (≤blockSeconds / maxChars each). */
export function mergeCues(cues: Cue[], blockSeconds = 45, maxChars = 600): { start: number; text: string }[] {
	const blocks: { start: number; text: string }[] = [];
	for (const cue of cues) {
		const text = (cue.content ?? "").replace(/\s+/g, " ").trim();
		if (!text) continue;
		const from = cue.from ?? 0;
		const last = blocks.at(-1);
		if (last && from - last.start < blockSeconds && last.text.length + text.length < maxChars) {
			last.text = joinText(last.text, text);
		} else {
			blocks.push({ start: from, text });
		}
	}
	return blocks;
}

export function formatTranscript(meta: TranscriptMeta, cues: Cue[]): string {
	const blocks = mergeCues(cues);
	const lines = [
		`# ${meta.part || meta.bvid || `av${meta.aid}`}${meta.pages > 1 ? ` (P${meta.page}/${meta.pages})` : ""}`,
		`${meta.bvid ?? `av${meta.aid}`} · cid ${meta.cid} · 时长 ${stamp(meta.duration)} · ${meta.langDoc || meta.lang} (${meta.lang}) · ${meta.cues} 条字幕`,
		`可用字幕: ${meta.tracks.join(", ")}`,
		"",
		...blocks.map((b) => `[${stamp(b.start)}] ${b.text}`),
	];
	return lines.join("\n");
}

// --- entry ---------------------------------------------------------------

/** Write the full transcript under ~/.pi/agent/cache and return a bounded head. */
export async function spillTranscript(
	text: string,
	meta: TranscriptMeta,
	maxInline: number,
): Promise<{ head: string; filePath: string }> {
	const { mkdir, writeFile } = await import("node:fs/promises");
	const dir = join(homedir(), ".pi", "agent", "cache", "bilibili-transcript");
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, `${meta.bvid ?? `av${meta.aid}`}-p${meta.page}-${meta.lang || "sub"}.md`);
	await writeFile(filePath, text, "utf8");
	return { head: text.slice(0, maxInline), filePath };
}

export async function fetchTranscript(opts: {
	input: string;
	page?: number;
	lang?: string;
	cookie?: string | null;
	signal?: AbortSignal;
}): Promise<Transcript> {
	const ref = await parseVideoInput(opts.input, opts.signal);
	const cookie = opts.cookie === undefined ? await loadCookie() : opts.cookie;
	const pages = await fetchPages(ref, cookie, opts.signal);
	const page = opts.page ?? ref.page ?? 1;
	if (page < 1 || page > pages.length) {
		throw new Error(`page ${page} is out of range: this video has ${pages.length} part(s)`);
	}
	const current = pages[page - 1];
	const tracks = await fetchTracks(ref, current.cid, cookie, opts.signal);
	const track = pickTrack(tracks, opts.lang);
	const cues = await fetchCues(track, opts.signal);
	if (!cues.length) throw new Error(`subtitle track ${track.lan} is empty`);

	const meta: TranscriptMeta = {
		bvid: ref.bvid,
		aid: ref.aid,
		cid: current.cid,
		page,
		pages: pages.length,
		part: current.part,
		duration: current.duration,
		lang: track.lan ?? "",
		langDoc: track.lan_doc ?? "",
		cues: cues.length,
		tracks: tracks.map((t) => t.lan ?? "?"),
	};
	return { text: formatTranscript(meta, cues), meta };
}
