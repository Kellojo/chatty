// Timing of one model call for tokens/sec stats, taken from the AI SDK's own step
// performance figures (`onStepEnd` / the `finish-step` stream part).

export interface InferenceTiming {
	/** Model call start -> first generated output (prompt processing + network). */
	ttftMs: number | null;
	/** First generated output -> end of the model response (generation). Tool runs excluded. */
	decodeMs: number | null;
}

export const NO_TIMING: InferenceTiming = { ttftMs: null, decodeMs: null };

/** The subset of the SDK's `StepResultPerformance` this needs. */
export interface StepPerformanceLike {
	responseTimeMs?: number;
	timeToFirstOutputMs?: number;
}

const ms = (value: number | undefined): number | null =>
	value != null && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

/** TTFT and generation time of a step; null parts when it wasn't streamed or timed. */
export function stepTiming(performance: StepPerformanceLike | null | undefined): InferenceTiming {
	const ttftMs = ms(performance?.timeToFirstOutputMs);
	const responseMs = ms(performance?.responseTimeMs);
	if (ttftMs === null) return NO_TIMING;
	// Without a response time only TTFT is known; such a call counts toward first-token and
	// input speed but not output speed.
	return { ttftMs, decodeMs: responseMs === null ? null : Math.max(0, responseMs - ttftMs) };
}

/** Sum of the timings of a reply's steps (null when no step was timed). */
export function addTiming(a: InferenceTiming, b: InferenceTiming): InferenceTiming {
	const add = (x: number | null, y: number | null) => (x === null ? y : y === null ? x : x + y);
	return { ttftMs: add(a.ttftMs, b.ttftMs), decodeMs: add(a.decodeMs, b.decodeMs) };
}
