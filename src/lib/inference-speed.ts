// Model speed (tokens per second) from logged inference timings. Shared by the
// Usage → Speed tab (server aggregation) and the per-reply / per-request views.

/**
 * Prompts shorter than this are left out of input speed: their time to first token is
 * mostly network and queueing, not prompt processing.
 */
export const MIN_PREFILL_TOKENS = 256;
/** Replies shorter than this are left out of output speed (too few tokens to time). */
export const MIN_DECODE_TOKENS = 16;
/** Generation times shorter than this are left out of output speed (timer noise). */
export const MIN_DECODE_MS = 100;

/** One timed model call. */
export interface SpeedSample {
	inputTokens: number | null;
	outputTokens: number | null;
	/** Input tokens read from the provider's prompt cache (not processed again). */
	cacheReadTokens: number | null;
	ttftMs: number | null;
	decodeMs: number | null;
}

/** `tokens` over `ms` in tokens per second, or null when either is missing or zero. */
export function tokensPerSecond(
	tokens: number | null | undefined,
	ms: number | null | undefined
): number | null {
	if (!tokens || !ms || tokens <= 0 || ms <= 0) return null;
	return (tokens * 1000) / ms;
}

/**
 * Input tokens the model actually processed (cache reads excluded). The AI SDK reports
 * `inputTokens` as the total including cache reads and writes for every provider (e.g. the
 * Anthropic adapter adds `cache_read_input_tokens` back in), so subtracting is right.
 */
export function prefillTokens(sample: Pick<SpeedSample, 'inputTokens' | 'cacheReadTokens'>) {
	if (sample.inputTokens == null) return null;
	return Math.max(0, sample.inputTokens - (sample.cacheReadTokens ?? 0));
}

/** Prompt processing speed of one call, or null when it is too small to tell. */
export function inputSpeed(sample: SpeedSample): number | null {
	const tokens = prefillTokens(sample);
	if (tokens == null || tokens < MIN_PREFILL_TOKENS) return null;
	return tokensPerSecond(tokens, sample.ttftMs);
}

/** Generation speed of one call, or null when it is too small to tell. */
export function outputSpeed(sample: SpeedSample): number | null {
	if (sample.outputTokens == null || sample.outputTokens < MIN_DECODE_TOKENS) return null;
	if (sample.decodeMs == null || sample.decodeMs < MIN_DECODE_MS) return null;
	return tokensPerSecond(sample.outputTokens, sample.decodeMs);
}

/** Median of `values`, or null when empty. */
export function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Value at quantile `q` (0–1, nearest rank) of `values`, or null when empty. */
export function quantile(values: number[], q: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
	return sorted[rank];
}

/** Speed figures over a set of timed calls. Medians, so one slow outlier doesn't skew them. */
export interface SpeedStats {
	/** Timed calls. */
	samples: number;
	/** Median prompt processing tok/s, and how many calls were big enough to count. */
	inputTps: number | null;
	inputSamples: number;
	/** Median generation tok/s, its 10th–90th percentile spread, and its sample count. */
	outputTps: number | null;
	outputP10: number | null;
	outputP90: number | null;
	outputSamples: number;
	/** Median time to first token. */
	ttftMs: number | null;
	/** Median context size (input tokens, cached included) the calls ran at. */
	contextTokens: number | null;
}

/**
 * Context-size bands for "speed by context": generation slows as the context (KV cache)
 * grows, most of all on small local models. Upper bounds are exclusive.
 */
export const CONTEXT_BUCKETS: { label: string; short: string; max: number }[] = [
	{ label: 'Under 2k', short: '<2k', max: 2048 },
	{ label: '2k–8k', short: '2–8k', max: 8192 },
	{ label: '8k–32k', short: '8–32k', max: 32_768 },
	{ label: '32k–128k', short: '32–128k', max: 131_072 },
	{ label: '128k+', short: '128k+', max: Infinity }
];

/** Index into CONTEXT_BUCKETS for a call's context size, or null when unknown. */
export function contextBucket(contextTokens: number | null | undefined): number | null {
	if (contextTokens == null || contextTokens < 0) return null;
	return CONTEXT_BUCKETS.findIndex((b) => contextTokens < b.max);
}

/** Speed figures, plus the same figures per context-size band (null where no calls ran). */
export interface ContextSpeedStats extends SpeedStats {
	byContext: (SpeedStats | null)[];
}

export function speedStats(samples: SpeedSample[]): SpeedStats {
	const input: number[] = [];
	const output: number[] = [];
	const ttft: number[] = [];
	const context: number[] = [];
	for (const s of samples) {
		if (s.inputTokens != null) context.push(s.inputTokens);
		const i = inputSpeed(s);
		if (i != null) input.push(i);
		const o = outputSpeed(s);
		if (o != null) output.push(o);
		if (s.ttftMs != null) ttft.push(s.ttftMs);
	}
	return {
		samples: samples.length,
		inputTps: median(input),
		inputSamples: input.length,
		outputTps: median(output),
		outputP10: quantile(output, 0.1),
		outputP90: quantile(output, 0.9),
		outputSamples: output.length,
		ttftMs: median(ttft),
		contextTokens: median(context)
	};
}

/** `speedStats`, plus per context band. */
export function contextSpeedStats(samples: SpeedSample[]): ContextSpeedStats {
	const bands: SpeedSample[][] = CONTEXT_BUCKETS.map(() => []);
	for (const s of samples) {
		const band = contextBucket(s.inputTokens);
		if (band != null) bands[band].push(s);
	}
	return {
		...speedStats(samples),
		byContext: bands.map((band) => (band.length > 0 ? speedStats(band) : null))
	};
}

export interface ModelSpeed extends ContextSpeedStats {
	providerId: string | null;
	providerName: string | null;
	model: string;
}

export interface ProviderSpeed extends ContextSpeedStats {
	providerId: string | null;
	providerName: string | null;
	models: number;
}

export interface SpeedSummary {
	overall: ContextSpeedStats;
	providers: ProviderSpeed[];
	models: ModelSpeed[];
}

export interface KeyedSpeedSample extends SpeedSample {
	providerId: string | null;
	providerName: string | null;
	model: string;
}

/** Fastest output first; models with no output figure go last, by sample count. */
function bySpeed(a: SpeedStats, b: SpeedStats): number {
	if (a.outputTps != null && b.outputTps != null) return b.outputTps - a.outputTps;
	if (a.outputTps != null) return -1;
	if (b.outputTps != null) return 1;
	return b.samples - a.samples;
}

/** Per-model and per-provider speed, plus figures across everything. */
export function summarizeSpeed(samples: KeyedSpeedSample[]): SpeedSummary {
	const byModel = new Map<string, KeyedSpeedSample[]>();
	const byProvider = new Map<string, KeyedSpeedSample[]>();
	for (const s of samples) {
		const providerKey = s.providerId ?? '';
		const modelKey = `${providerKey}\u0000${s.model}`;
		(byModel.get(modelKey) ?? byModel.set(modelKey, []).get(modelKey)!).push(s);
		(byProvider.get(providerKey) ?? byProvider.set(providerKey, []).get(providerKey)!).push(s);
	}
	const models: ModelSpeed[] = [...byModel.values()].map((rows) => ({
		providerId: rows[0].providerId,
		providerName: rows[0].providerName,
		model: rows[0].model,
		...contextSpeedStats(rows)
	}));
	const providers: ProviderSpeed[] = [...byProvider.values()].map((rows) => ({
		providerId: rows[0].providerId,
		providerName: rows[0].providerName,
		models: new Set(rows.map((r) => r.model)).size,
		...contextSpeedStats(rows)
	}));
	return {
		overall: contextSpeedStats(samples),
		providers: providers.sort(bySpeed),
		models: models.sort(bySpeed)
	};
}

/** "42.1", "312", "1.2k" tok/s; "—" when unknown. */
export function formatTps(tps: number | null | undefined): string {
	if (tps == null || !Number.isFinite(tps)) return '—';
	if (tps >= 10_000) return `${Math.round(tps / 1000)}k`;
	if (tps >= 1000) return `${(tps / 1000).toFixed(1)}k`;
	if (tps >= 100) return String(Math.round(tps));
	return tps.toFixed(1);
}

/** "800", "6.2k", "128k" tokens; "—" when unknown. */
export function formatTokensShort(tokens: number | null | undefined): string {
	if (tokens == null || !Number.isFinite(tokens)) return '—';
	if (tokens < 1000) return String(Math.round(tokens));
	if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${Math.round(tokens / 1000)}k`;
}

/** "850 ms", "2.4 s"; "—" when unknown. */
export function formatMs(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms)) return '—';
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
	return `${Math.round(ms / 1000)} s`;
}
