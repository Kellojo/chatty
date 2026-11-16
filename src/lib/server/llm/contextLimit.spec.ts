import { APICallError } from 'ai';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	forgetLearnedContextLimit,
	isContextOverflowError,
	learnedContextInfo,
	learnedContextLength,
	MIN_LEARNED_CONTEXT,
	noteContextOverflow,
	noteContextSuccess,
	resetLearnedContextLimits,
	statedContextLimit
} from './contextLimit.js';

const ref = { providerId: 'p', modelId: 'm' };

describe('context overflow errors', () => {
	it.each([
		'Engine protocol predict stream returned an error: Context size has been exceeded.',
		"This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
		'the request exceeds the available context size, try increasing it',
		'prompt is too long: 210000 tokens > 200000 maximum'
	])('recognises %j', (message) => {
		expect(isContextOverflowError(new Error(message))).toBe(true);
	});

	it('ignores unrelated errors', () => {
		expect(isContextOverflowError(new Error('rate limit exceeded'))).toBe(false);
		expect(isContextOverflowError(null)).toBe(false);
	});

	it('reads the error from an API response body', () => {
		const error = new APICallError({
			message: 'Bad Request',
			url: 'http://lm/v1/chat/completions',
			requestBodyValues: {},
			statusCode: 400,
			responseBody: '{"error":"Context size has been exceeded."}'
		});
		expect(isContextOverflowError(error)).toBe(true);
	});

	it('extracts a stated limit', () => {
		expect(statedContextLimit(new Error('maximum context length is 8192 tokens'))).toBe(8192);
		expect(statedContextLimit(new Error('Context size has been exceeded.'))).toBeNull();
	});
});

describe('learned context limits', () => {
	beforeEach(() => resetLearnedContextLimits());

	it('caps the limit at the failed prompt and only lowers it for smaller failures', () => {
		expect(learnedContextLength(ref, 75_000)).toBeNull();
		expect(noteContextOverflow(ref, { promptTokens: 20_000, basis: 75_000 })).toBe(20_000);
		// A bigger prompt failing tells nothing new.
		expect(noteContextOverflow(ref, { promptTokens: 30_000, basis: 75_000 })).toBe(20_000);
		expect(noteContextOverflow(ref, { promptTokens: 18_000, basis: 75_000 })).toBe(18_000);
		expect(learnedContextLength(ref, 75_000)).toBe(18_000);
	});

	it('never drops below the largest request that fit', () => {
		noteContextOverflow(ref, { promptTokens: 20_000, basis: null });
		noteContextSuccess(ref, { tokens: 17_000, basis: null });
		expect(noteContextOverflow(ref, { promptTokens: 9_000, basis: null })).toBe(17_000);
		// A success beyond the ceiling lifts it.
		noteContextSuccess(ref, { tokens: 25_000, basis: null });
		expect(learnedContextLength(ref, null)).toBe(25_000);
	});

	it('prefers the limit an error states and keeps a minimum', () => {
		expect(
			noteContextOverflow(ref, { promptTokens: 50_000, statedLimit: 16_384, basis: null })
		).toBe(16_384);
		resetLearnedContextLimits();
		expect(noteContextOverflow(ref, { promptTokens: 100, basis: null })).toBe(MIN_LEARNED_CONTEXT);
	});

	it('forgets the limit when the reported context changes or it expires', () => {
		noteContextOverflow(ref, { promptTokens: 20_000, basis: 75_000 }, 0);
		expect(learnedContextLength(ref, 75_000, 1000)).toBe(20_000);
		expect(learnedContextLength(ref, 131_072, 1000)).toBeNull();
		noteContextOverflow(ref, { promptTokens: 20_000, basis: 75_000 }, 0);
		expect(learnedContextLength(ref, 75_000, 25 * 60 * 60 * 1000)).toBeNull();
	});

	it('describes and forgets what was learned', () => {
		expect(learnedContextInfo(ref, null)).toBeNull();
		noteContextOverflow(ref, { promptTokens: 20_000, basis: null }, 1000);
		noteContextSuccess(ref, { tokens: 12_000, basis: null }, 2000);
		expect(learnedContextInfo(ref, null, 3000)).toEqual({
			limit: 20_000,
			largestFit: 12_000,
			learnedAt: 1000,
			expiresAt: 1000 + 24 * 60 * 60 * 1000
		});
		expect(forgetLearnedContextLimit(ref)).toBe(true);
		expect(learnedContextLength(ref, null)).toBeNull();
	});
});
