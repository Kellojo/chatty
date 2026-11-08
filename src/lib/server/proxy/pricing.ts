export function computeCostUsd(
	priceInput: number | null,
	priceOutput: number | null,
	inputTokens: number | undefined | null,
	outputTokens: number | undefined | null
): number | null {
	if (priceInput == null || priceOutput == null || inputTokens == null || outputTokens == null) {
		return null;
	}
	return (inputTokens * priceInput + outputTokens * priceOutput) / 1_000_000;
}

/** USD per 1M tokens, as stored on a `models` row. */
export interface ModelPrices {
	price_input: number | null;
	price_output: number | null;
	/** Prompt-cache read price; NULL/absent falls back to `price_input`. */
	price_cache_read?: number | null;
	/** Prompt-cache write price; NULL/absent falls back to `price_input`. */
	price_cache_write?: number | null;
}

/** The subset of the AI SDK's `LanguageModelUsage` that pricing needs. */
export interface PricedUsage {
	/** Total input tokens, including cache reads and writes. */
	inputTokens?: number | null;
	outputTokens?: number | null;
	inputTokenDetails?: {
		noCacheTokens?: number | null;
		cacheReadTokens?: number | null;
		cacheWriteTokens?: number | null;
	} | null;
}

/** Cache read/write token counts of a usage report (null when not reported). */
export function cacheTokens(usage: PricedUsage | null | undefined): {
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
} {
	return {
		cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens ?? null,
		cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? null
	};
}

/**
 * Cost of a model call with cached input tokens priced separately. Uncached
 * input uses `price_input`; cache reads/writes use their own prices when set
 * and `price_input` otherwise, so the result equals `computeCostUsd` until a
 * cache price is configured. Null when the input/output price or token counts
 * are unknown.
 */
export function computeUsageCostUsd(
	prices: ModelPrices | null | undefined,
	usage: PricedUsage | null | undefined
): number | null {
	const priceInput = prices?.price_input ?? null;
	const priceOutput = prices?.price_output ?? null;
	const inputTokens = usage?.inputTokens ?? null;
	const outputTokens = usage?.outputTokens ?? null;
	if (priceInput == null || priceOutput == null || inputTokens == null || outputTokens == null) {
		return null;
	}
	const details = usage?.inputTokenDetails;
	const cacheRead = details?.cacheReadTokens ?? 0;
	const cacheWrite = details?.cacheWriteTokens ?? 0;
	const noCache = details?.noCacheTokens ?? Math.max(0, inputTokens - cacheRead - cacheWrite);
	const readPrice = prices?.price_cache_read ?? priceInput;
	const writePrice = prices?.price_cache_write ?? priceInput;
	return (
		(noCache * priceInput +
			cacheRead * readPrice +
			cacheWrite * writePrice +
			outputTokens * priceOutput) /
		1_000_000
	);
}
