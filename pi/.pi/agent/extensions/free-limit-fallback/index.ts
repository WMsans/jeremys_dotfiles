/**
 * Free-Limit Fallback Extension
 *
 * When the opencode free tier hits its usage limit, pi receives:
 *   Error: OpenAI API error (429): {"type":"FreeUsageLimitError",...}
 * pi treats this as a terminal error (no auto-retry) and the work stops.
 *
 * This extension detects exactly that failure, switches the session to the
 * next provider/model in a user-configured fallback list, and resumes the
 * work with "continue". If every fallback also hits the limit, it waits a
 * short backoff and retries the list for a few rounds, then gives up.
 *
 * - Only activates on the FreeUsageLimitError 429 message (stopReason "error").
 *   Manual aborts (stopReason "aborted") and any other error never trigger it.
 * - Explicitly toggled on/off: `/fallback on` / `/fallback off` / `/fallback`
 *   (settings page). Off by default with an empty fallback list.
 * - Config stored in <agentDir>/fallback-provider.json.
 *
 * Usage:
 *   Place in ~/.pi/agent/extensions/ (auto-discovered). Then:
 *     /fallback          -> open the settings page
 *     /fallback on|off   -> quick toggle
 *     /fallback status   -> one-line status
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import {
	DEFAULT_CONFIG,
	detectFreeUsageLimit,
	isValidFallback,
	nextFallback,
	splitFallback,
	type FallbackConfig,
} from "./core.ts";

const CONFIG_FILE = path.join(getAgentDir(), "fallback-provider.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Config load/save
// ---------------------------------------------------------------------------

function loadConfig(): FallbackConfig {
	try {
		const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
		const parsed = JSON.parse(raw) as Partial<FallbackConfig>;
		const cfg: FallbackConfig = {
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_CONFIG.enabled,
			maxRounds:
				typeof parsed.maxRounds === "number" && parsed.maxRounds >= 1
					? Math.floor(parsed.maxRounds)
					: DEFAULT_CONFIG.maxRounds,
			roundBackoffMs:
				typeof parsed.roundBackoffMs === "number" && parsed.roundBackoffMs >= 0
					? parsed.roundBackoffMs
					: DEFAULT_CONFIG.roundBackoffMs,
			fallbacks: Array.isArray(parsed.fallbacks)
				? parsed.fallbacks.filter((f): f is string => typeof f === "string" && isValidFallback(f))
				: [],
		};
		return cfg;
	} catch {
		return { ...DEFAULT_CONFIG, fallbacks: [] };
	}
}

function saveConfig(cfg: FallbackConfig): void {
	try {
		fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
	} catch (err) {
		console.error("[free-limit-fallback] failed to write config:", err);
	}
}

// ---------------------------------------------------------------------------
// Settings page (/fallback)
// ---------------------------------------------------------------------------

function buildSettingsItems(cfg: FallbackConfig): SelectItem[] {
	const items: SelectItem[] = [
		{
			value: "toggle",
			label: `Status: ${cfg.enabled ? "enabled" : "disabled"}`,
			description: cfg.enabled
				? "Fallback switching is ON"
				: "Fallback switching is OFF — no automatic provider switching",
		},
		{
			value: "maxrounds",
			label: `Max rounds: ${cfg.maxRounds}`,
			description: "Passes through the fallback list before giving up",
		},
		{
			value: "backoff",
			label: `Backoff: ${Math.round(cfg.roundBackoffMs / 1000)}s`,
			description: "Wait between rounds when every fallback is rate-limited",
		},
		{ value: "add", label: "Add fallback...", description: "Format: provider/model (e.g. opencode-go/deepseek-v4-flash)" },
	];
	if (cfg.fallbacks.length > 0) {
		items.push({ value: "clear", label: "Clear all fallbacks", description: "Remove every entry" });
	}
	for (const fb of cfg.fallbacks) {
		items.push({ value: `remove:${fb}`, label: `Remove ${fb}`, description: "Delete this fallback" });
	}
	items.push({ value: "done", label: "Done", description: "Close settings" });
	return items;
}

async function showSettingsPage(ctx: ExtensionContext, cfg: FallbackConfig): Promise<string | null> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/fallback settings page requires TUI mode", "error");
		return "done";
	}

	const items = buildSettingsItems(cfg);

	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Free-Limit Fallback Settings")), 0, 0));
		container.addChild(
			new Text(theme.fg("dim", "Switches provider when the opencode free tier returns 429"), 0, 0),
		);
		container.addChild(new Text("", 0, 0));

		const selectList = new SelectList(items, Math.min(items.length + 2, 14), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);

		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 0, 0));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

async function runSettingsLoop(ctx: ExtensionContext, cfg: FallbackConfig): Promise<void> {
	let open = true;
	while (open) {
		const action = await showSettingsPage(ctx, cfg);
		if (action === null || action === "done") {
			open = false;
			continue;
		}
		if (action === "toggle") {
			cfg.enabled = !cfg.enabled;
			saveConfig(cfg);
			ctx.ui.notify(`Free-limit fallback: ${cfg.enabled ? "enabled" : "disabled"}`, "info");
		} else if (action === "maxrounds") {
			const v = await ctx.ui.input("Max rounds (1-10):", String(cfg.maxRounds));
			const n = v !== undefined ? parseInt(v.trim(), 10) : NaN;
			if (Number.isFinite(n) && n >= 1 && n <= 10) {
				cfg.maxRounds = n;
				saveConfig(cfg);
			} else if (v !== undefined && v.trim() !== "") {
				ctx.ui.notify("Invalid max rounds (use 1-10)", "warning");
			}
		} else if (action === "backoff") {
			const v = await ctx.ui.input("Backoff between rounds (seconds):", String(Math.round(cfg.roundBackoffMs / 1000)));
			const n = v !== undefined ? parseInt(v.trim(), 10) : NaN;
			if (Number.isFinite(n) && n >= 0) {
				cfg.roundBackoffMs = n * 1000;
				saveConfig(cfg);
			} else if (v !== undefined && v.trim() !== "") {
				ctx.ui.notify("Invalid backoff (seconds, >= 0)", "warning");
			}
		} else if (action === "add") {
			const v = await ctx.ui.input("Add fallback (provider/model):", "");
			if (v !== undefined && v.trim() !== "") {
				const entry = v.trim();
				if (isValidFallback(entry)) {
					cfg.fallbacks.push(entry);
					saveConfig(cfg);
					ctx.ui.notify(`Added fallback: ${entry}`, "info");
				} else {
					ctx.ui.notify(`Invalid format — expected provider/model (e.g. opencode-go/deepseek-v4-flash)`, "warning");
				}
			}
		} else if (action === "clear") {
			cfg.fallbacks = [];
			saveConfig(cfg);
			ctx.ui.notify("Cleared all fallbacks", "info");
		} else if (action.startsWith("remove:")) {
			const entry = action.slice("remove:".length);
			cfg.fallbacks = cfg.fallbacks.filter((f) => f !== entry);
			saveConfig(cfg);
			ctx.ui.notify(`Removed fallback: ${entry}`, "info");
		}
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let cfg = loadConfig();

	// Per-session recovery state
	let freeUsageLimitHit = false;
	let rounds = 0;
	let shuttingDown = false;

	const resetState = () => {
		freeUsageLimitHit = false;
		rounds = 0;
	};

	// -------------------------------------------------------------------
	// Session lifecycle
	// -------------------------------------------------------------------

	pi.on("session_start", () => {
		cfg = loadConfig();
		shuttingDown = false;
		resetState();
	});

	pi.on("session_shutdown", () => {
		shuttingDown = true;
	});

	pi.on("turn_start", () => {
		freeUsageLimitHit = false;
	});

	// -------------------------------------------------------------------
	// Detection: only the FreeUsageLimitError 429, only on failed runs
	// -------------------------------------------------------------------

	pi.on("agent_end", (event) => {
		for (const msg of event.messages ?? []) {
			const m = msg as { stopReason?: string; errorMessage?: string };
			if (m.stopReason === "error" && detectFreeUsageLimit(m.errorMessage)) {
				freeUsageLimitHit = true;
				break;
			}
		}
	});

	// -------------------------------------------------------------------
	// Recovery at agent_settled (pi has no retry left)
	// -------------------------------------------------------------------

	pi.on("agent_settled", async (_event, ctx) => {
		// Never act during shutdown — the user is exiting/switching sessions.
		if (shuttingDown) return;

		// Successful run (or failure we don't own): reset and move on.
		if (!freeUsageLimitHit) {
			rounds = 0;
			return;
		}
		freeUsageLimitHit = false;

		// Master switch / configured fallbacks.
		if (!cfg.enabled || cfg.fallbacks.length === 0) {
			rounds = 0;
			return;
		}

		const current = ctx.model as { provider?: string; id?: string } | undefined;

		const trySwitch = async (fallback: string): Promise<boolean> => {
			const { provider, modelId } = splitFallback(fallback);
			const model = ctx.modelRegistry.find(provider, modelId);
			if (!model) {
				ctx.ui.notify(`Fallback ${fallback}: model not found, skipping`, "warning");
				return false;
			}
			const ok = await pi.setModel(model);
			if (!ok) {
				ctx.ui.notify(`Fallback ${fallback}: no API key available, skipping`, "warning");
				return false;
			}
			ctx.ui.notify(`Free-limit fallback: switched to ${fallback}`, "info");
			return true;
		};

		// Walk the list: next entry after the current model, skipping entries
		// that cannot be used (unknown model / no API key). Exhausting the
		// list ends one round; back off and restart until maxRounds.
		let candidate = nextFallback(cfg.fallbacks, current?.provider, current?.id);
		while (rounds < cfg.maxRounds) {
			while (candidate) {
				if (await trySwitch(candidate)) {
					pi.sendUserMessage("continue");
					return;
				}
				const { provider, modelId } = splitFallback(candidate);
				candidate = nextFallback(cfg.fallbacks, provider, modelId);
			}
			rounds++;
			if (rounds >= cfg.maxRounds) break;
			ctx.ui.notify(
				`Free-limit fallback: all fallbacks rate-limited. ` +
					`Round ${rounds + 1}/${cfg.maxRounds} in ${Math.round(cfg.roundBackoffMs / 1000)}s...`,
				"warning",
			);
			await sleep(cfg.roundBackoffMs);
			// The user may have started a new turn during the backoff — don't
			// hijack it with a stale "continue".
			if (!ctx.isIdle()) return;
			candidate = cfg.fallbacks[0];
		}

		ctx.ui.notify(
			`Free-limit fallback: all ${cfg.fallbacks.length} fallback(s) failed after ${cfg.maxRounds} round(s). Giving up.`,
			"error",
		);
		rounds = 0;
	});

	// -------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------

	pi.registerCommand("fallback", {
		description: "Free-limit fallback: on|off|status, or open the settings page",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();

			if (arg === "on" || arg === "enable") {
				cfg.enabled = true;
				saveConfig(cfg);
				ctx.ui.notify(
					cfg.fallbacks.length > 0
						? `Free-limit fallback enabled (${cfg.fallbacks.length} fallback(s))`
						: "Free-limit fallback enabled — add fallbacks with /fallback",
					"info",
				);
				return;
			}
			if (arg === "off" || arg === "disable") {
				cfg.enabled = false;
				saveConfig(cfg);
				ctx.ui.notify("Free-limit fallback disabled", "info");
				return;
			}
			if (arg === "status") {
				const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
				const list = cfg.fallbacks.length > 0 ? cfg.fallbacks.join(", ") : "(empty)";
				ctx.ui.notify(
					`Free-limit fallback: ${cfg.enabled ? "enabled" : "disabled"} | ` +
						`fallbacks: ${list} | maxRounds: ${cfg.maxRounds} | current model: ${current}`,
					"info",
				);
				return;
			}
			if (arg !== "") {
				ctx.ui.notify("Usage: /fallback [on|off|status] (no args opens settings)", "warning");
				return;
			}

			await runSettingsLoop(ctx, cfg);
		},
	});
}
