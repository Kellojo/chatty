import { APICallError, RetryError } from 'ai';

/**
 * Context limits learned from what a model actually accepts. A server can
 * reject prompts below the context it reports (LM Studio splits its context
 * across parallel slots) or report none at all, so every overflow error lowers
 * a per-model ceiling and every success raises a floor:
 *
 * - a failed prompt of N tokens caps the limit at N (or at the size the error
 *   names), so it only drops further if a smaller prompt fails too;
 * - a request that fit proves the window holds it, so the limit never falls
 *   below the largest success;
 * - it is forgotten when the reported context changes (the model was reloaded)
 *   or after a day, and never goes below {@link MIN_LEARNED_CONTEXT}.
 *
 * Kept in memory: after a restart one failure relearns it.
 */

export const MIN_LEARNED_CONTEXT = 4096;
const TTL_MS = 24 * 60 * 60 * 1000;

interface Learned {
	/** Smallest prompt (tokens) known not to fit. */
	ceiling: number;
	/** Largest prompt plus reply (tokens) known to fit. */
	floor: number;
	/** The reported context when this was learned; a change invalidates it. */
	basis: number | null;
	at: number;
}

const learned = new Map<string, Learned>();

type ModelKey = { providerId: string; modelId: string };
const keyOf = (ref: ModelKey) => `${ref.providerId}\u0000${ref.modelId}`;

function errorTexts(error: unknown, depth = 0): string[] {
	if (!error || depth > 4) return [];
	if (RetryError.isInstance(error)) return errorTexts(error.lastError, depth + 1);
	const texts: string[] = [];
	if (error instanceof Error) texts.push(error.message);
	else if (typeof error === 'string') texts.push(error);
	else {
		try {
			texts.push(JSON.stringify(error));
		} catch {
			// unserialisable: nothing to read
		}
	}
	if (APICallError.isInstance(error) && error.responseBody) texts.push(error.responseBody);
	const cause = (error as { cause?: unknown }).cause;
	if (cause) texts.push(...errorTexts(cause, depth + 1));
	return texts;
}

const OVERFLOW_PATTERNS = [
	/context[\s_-]*(size|length|window)[^.\n]{0,40}(exceed|overflow|too (long|large|small))/i,
	/exceed(s|ed|ing)?[^.\n]{0,40}context[\s_-]*(size|length|window)/i,
	/context_length_exceeded/i,
	/maximum context length/i,
	/prompt is too long/i,
	/input is too long for (the|this) model/i
];

/** Whether a model call failed because the prompt didn't fit its context window. */
export function isContextOverflowError(error: unknown): boolean {
	return errorTexts(error).some((t) => OVERFLOW_PATTERNS.some((p) => p.test(t)));
}

const LIMIT_PATTERNS = [
	/maximum context length is (\d+)/i,
	/context (?:size|length|window) \((\d+) tokens\)/i,
	/n_ctx(?:_slot)?\s*[:=]\s*(\d+)/i
];

/** The context size an overflow error states, when it names one. */
export function statedContextLimit(error: unknown): number | null {
	for (const text of errorTexts(error)) {
		for (const pattern of LIMIT_PATTERNS) {
			const n = Number(pattern.exec(text)?.[1]);
			if (Number.isFinite(n) && n > 0) return n;
		}
	}
	return null;
}

function current(ref: ModelKey, basis: number | null, now: number): Learned | undefined {
	const entry = learned.get(keyOf(ref));
	if (!entry) return undefined;
	if (now - entry.at > TTL_MS || entry.basis !== basis) {
		learned.delete(keyOf(ref));
		return undefined;
	}
	return entry;
}

/**
 * Records an overflow: `promptTokens` (or the limit the error states) did not
 * fit. Returns the context length to budget against from now on.
 */
export function noteContextOverflow(
	ref: ModelKey,
	input: { promptTokens: number; statedLimit?: number | null; basis: number | null },
	now = Date.now()
): number {
	const entry = current(ref, input.basis, now);
	const failedAt = Math.max(
		MIN_LEARNED_CONTEXT,
		Math.floor(input.statedLimit ?? input.promptTokens)
	);
	const floor = entry?.floor ?? 0;
	const ceiling = Math.max(
		Math.min(entry?.ceiling ?? Infinity, failedAt),
		floor,
		MIN_LEARNED_CONTEXT
	);
	learned.set(keyOf(ref), { ceiling, floor, basis: input.basis, at: now });
	return ceiling;
}

/** Records a request that fit: `tokens` (prompt plus reply) are within the window. */
export function noteContextSuccess(
	ref: ModelKey,
	input: { tokens: number; basis: number | null },
	now = Date.now()
): void {
	const entry = current(ref, input.basis, now);
	// Nothing learned yet: there is no ceiling to keep in check.
	if (!entry || !(input.tokens > entry.floor)) return;
	entry.floor = Math.floor(input.tokens);
	entry.ceiling = Math.max(entry.ceiling, entry.floor);
}

/** The learned limit for a model, or null when none applies. */
export function learnedContextLength(
	ref: ModelKey,
	basis: number | null,
	now = Date.now()
): number | null {
	return current(ref, basis, now)?.ceiling ?? null;
}

export interface LearnedContextInfo {
	/** The context length budgeted against. */
	limit: number;
	/** Largest prompt plus reply seen to fit (0 when none since). */
	largestFit: number;
	learnedAt: number;
	expiresAt: number;
}

/** What has been learned for a model, for display; null when nothing applies. */
export function learnedContextInfo(
	ref: ModelKey,
	basis: number | null,
	now = Date.now()
): LearnedContextInfo | null {
	const entry = current(ref, basis, now);
	if (!entry) return null;
	return {
		limit: entry.ceiling,
		largestFit: entry.floor,
		learnedAt: entry.at,
		expiresAt: entry.at + TTL_MS
	};
}

/** Drops a model's learned limit, e.g. after its server was reconfigured. */
export function forgetLearnedContextLimit(ref: ModelKey): boolean {
	return learned.delete(keyOf(ref));
}

/** For tests. */
export function resetLearnedContextLimits(): void {
	learned.clear();
}
