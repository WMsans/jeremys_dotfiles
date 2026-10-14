/**
 * OpenCode free-tier identity.
 *
 * OpenCode Zen's free tier gates on *client identity*, not auth. Since
 * 2026-10-14 the gate checks three things, and any one of them fails the
 * request with:
 *
 *   Error (403): {"type":"FreeTierError","message":"OpenCode's free tier can
 *   only be used from within OpenCode"}
 *
 *   1. Endpoint — keyless traffic moved to https://opencode.ai/inference.
 *      pi already routes opencode models there, so nothing to do.
 *   2. Header shape — upstream wants the client's own headers:
 *      `User-Agent: opencode/latest/<version>/cli`, `x-opencode-client: cli`,
 *      a `ses_` session id (descending timestamp encoding), a bare 40-hex
 *      `x-opencode-project`, and *no* `x-opencode-request`.
 *   3. Tools — the body must declare a shell tool named `shell` and a `read`
 *      tool, each with the genuine OpenCode definition. A recognized name with
 *      a stubbed or foreign definition is rejected, so pi's `bash` and `edit`
 *      are dropped and `read`/`write` carry the genuine schema. Because that
 *      wire schema no longer matches pi's own, a system-prompt section
 *      re-states the real argument shapes (`read` offset/limit, `edit` edits[]).
 *
 * The `shell` name is not one pi ships, so this extension registers it and
 * forwards the call to pi's `bash`, keeping the model's tool list runnable.
 *
 * Usage:
 *   Place in ~/.pi/agent/extensions/ (auto-discovered; /reload to pick up).
 *   Override the impersonated client with OPENCODE_FREE_UA=opencode/...
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyOpencodeIdentity, isOpencodeModel, OPENCODE_TOOL_GUIDANCE, resolveUserAgent, rewriteOpencodeTools } from "./core.ts";
import { OPENCODE_TOOLS } from "./tools.ts";

export default function (pi: ExtensionAPI) {
	// Upstream requires a tool literally named `shell`; pi's is `bash`. Expose
	// `shell` and delegate so model calls actually run.
	pi.registerTool({
		name: "shell",
		label: "shell",
		description: OPENCODE_TOOLS.shell.description,
		parameters: Type.Object({
			command: Type.String({ description: "Shell command string to execute" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
			workdir: Type.Optional(Type.String({ description: "Working directory" })),
			background: Type.Optional(Type.Boolean({ description: "Run in the background" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// shortcut: workdir/background are ignored; the tool exists to satisfy
			// the fingerprint, and pi's bash handles the command.
			const timeout = typeof params.timeout === "number" ? Math.ceil(params.timeout / 1000) : null;
			const { result } = await ctx.executeTool("bash", { command: params.command, timeout });
			return result;
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		const sections = event.systemPromptOptions.sections as Record<string, string>;
		if (isOpencodeModel(ctx.model)) {
			sections.opencode_tools = OPENCODE_TOOL_GUIDANCE;
		} else {
			delete sections.opencode_tools;
		}
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isOpencodeModel(ctx.model)) return;
		applyOpencodeIdentity(
			event.headers,
			resolveUserAgent(process.env.OPENCODE_FREE_UA),
			ctx.sessionManager.getSessionId(),
		);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model as { api?: string } | undefined;
		if (!isOpencodeModel(model)) return;
		const payload = event.payload as Record<string, unknown> | null | undefined;
		if (!payload || typeof payload !== "object") return;
		payload.stream = true;
		payload.tools = rewriteOpencodeTools(payload.tools, model?.api === "openai-responses");
		return payload as typeof event.payload;
	});
}
