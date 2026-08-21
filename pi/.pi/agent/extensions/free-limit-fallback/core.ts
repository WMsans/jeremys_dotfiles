/**
 * Pure logic for the free-limit-fallback extension.
 * No pi imports — unit-testable in isolation.
 */

export interface FallbackConfig {
	/** Master switch. When false the extension never acts. */
	enabled: boolean;
	/** How many passes through the fallback list before giving up. */
	maxRounds: number;
	/** Wait between rounds when every fallback was rate-limited. */
	roundBackoffMs: number;
	/** Ordered list of "provider/model" fallbacks, tried in order. */
	fallbacks: string[];
}

export const DEFAULT_CONFIG: FallbackConfig = {
	enabled: false,
	maxRounds: 3,
	roundBackoffMs: 15_000,
	fallbacks: [],
};

/**
 * True only for the exact opencode Console free-tier 429:
 *   Error: OpenAI API error (429): {"type":"FreeUsageLimitError",...}
 * Requires BOTH "429" and "FreeUsageLimitError" so plain rate limits,
 * other usage-limit types (GoUsageLimitError), and aborts never trigger.
 */
export function detectFreeUsageLimit(errorMessage: string | undefined | null): boolean {
	if (!errorMessage) return false;
	return errorMessage.includes("429") && errorMessage.includes("FreeUsageLimitError");
}

/** Split "provider/model" into parts. Missing provider yields "". */
export function splitFallback(fallback: string): { provider: string; modelId: string } {
	const idx = fallback.indexOf("/");
	if (idx === -1) return { provider: "", modelId: fallback.trim() };
	return { provider: fallback.slice(0, idx).trim(), modelId: fallback.slice(idx + 1).trim() };
}

/** A usable fallback entry must name both a provider and a model. */
export function isValidFallback(fallback: string): boolean {
	const { provider, modelId } = splitFallback(fallback);
	return provider.length > 0 && modelId.length > 0;
}

/**
 * Pick the next fallback to try.
 * - Current model not in the list (e.g. the rate-limited opencode free model)
 *   -> start at index 0.
 * - Current model at index i < len-1 -> return i+1.
 * - Current model at the last index -> null (round exhausted).
 * Bare model ids also match their "provider/model" entries.
 */
export function nextFallback(
	fallbacks: string[] | undefined,
	provider: string | undefined,
	modelId: string | undefined,
): string | null {
	if (!fallbacks || fallbacks.length === 0) return null;
	const current = `${provider ?? ""}/${modelId ?? ""}`;
	// Prefer an exact provider/model match; fall back to matching by bare model id.
	let idx = fallbacks.findIndex((f) => f === current);
	if (idx === -1 && modelId) idx = fallbacks.findIndex((f) => splitFallback(f).modelId === modelId);
	if (idx === -1) return fallbacks[0];
	if (idx >= fallbacks.length - 1) return null;
	return fallbacks[idx + 1];
}
