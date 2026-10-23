/**
 * Bilibili Transcript Tool - fetch the subtitle track of a bilibili video.
 *
 * Usage: place in ~/.pi/agent/extensions/bilibili-transcript/ (auto-discovered).
 * Needs a logged-in bilibili cookie; see core.ts for the lookup order.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchTranscript, spillTranscript, type Transcript, type TranscriptMeta } from "./core.ts";

/** Keep model-facing output bounded; the rest goes to a file. */
const MAX_INLINE = 30_000;

interface Details extends TranscriptMeta {
	chars: number;
	filePath?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "bilibili_transcript",
		label: "Bilibili Transcript",
		description:
			"Fetch the transcript (subtitle track) of a bilibili video as timestamped text. Accepts a video URL, a BV id, or an av id; b23.tv short links and ?p= parts work. Defaults to the simplified Chinese track when the video has several languages. Requires a logged-in bilibili cookie on this machine.",
		parameters: Type.Object({
			url: Type.String({ description: "Bilibili video URL, BV id, or av id" }),
			page: Type.Optional(Type.Number({ description: "1-based part number for multi-part videos (default 1 or the URL's ?p=)" })),
			lang: Type.Optional(
				Type.String({ description: "Subtitle language code, e.g. zh-Hans, zh-CN, en-US. Default: prefer Chinese." }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			let transcript: Transcript;
			try {
				transcript = await fetchTranscript({
					input: params.url,
					page: params.page,
					lang: params.lang,
					signal,
				});
			} catch (error) {
				throw new Error(`bilibili_transcript: ${error instanceof Error ? error.message : String(error)}`);
			}

			const { text, meta } = transcript;
			let body = text;
			let filePath: string | undefined;
			if (text.length > MAX_INLINE) {
				const spilled = await spillTranscript(text, meta, MAX_INLINE);
				body = `${spilled.head}\n\n…transcript truncated at ${MAX_INLINE} of ${text.length} chars. Full text: ${spilled.filePath}`;
				filePath = spilled.filePath;
			}

			const details: Details = { ...meta, chars: text.length, ...(filePath ? { filePath } : {}) };
			return {
				content: [{ type: "text", text: body }],
				details,
			};
		},
	});
}
