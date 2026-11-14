import { describe, expect, it } from 'vitest';
import {
	contextBucket,
	contextSpeedStats,
	formatMs,
	formatTokensShort,
	formatTps,
	inputSpeed,
	median,
	outputSpeed,
	quantile,
	summarizeSpeed,
	tokensPerSecond,
	type KeyedSpeedSample
} from './inference-speed.js';

const sample = (over: Partial<KeyedSpeedSample> = {}): KeyedSpeedSample => ({
	providerId: 'p1',
	providerName: 'Local',
	model: 'm1',
	inputTokens: 2000,
	outputTokens: 500,
	cacheReadTokens: null,
	ttftMs: 1000,
	decodeMs: 10_000,
	...over
});

describe('tokensPerSecond', () => {
	it('divides tokens by seconds and rejects missing or zero values', () => {
		expect(tokensPerSecond(500, 10_000)).toBe(50);
		expect(tokensPerSecond(null, 100)).toBeNull();
		expect(tokensPerSecond(10, 0)).toBeNull();
	});
});

describe('inputSpeed / outputSpeed', () => {
	it('measures prompt processing over uncached input only', () => {
		expect(inputSpeed(sample())).toBe(2000);
		expect(inputSpeed(sample({ cacheReadTokens: 1000 }))).toBe(1000);
	});
	it('skips prompts and replies too small to time', () => {
		expect(inputSpeed(sample({ inputTokens: 100 }))).toBeNull();
		expect(inputSpeed(sample({ inputTokens: 3000, cacheReadTokens: 2900 }))).toBeNull();
		expect(outputSpeed(sample({ outputTokens: 3 }))).toBeNull();
		expect(outputSpeed(sample({ decodeMs: 20 }))).toBeNull();
		expect(outputSpeed(sample())).toBe(50);
	});
});

describe('median / quantile', () => {
	it('handles odd, even and empty lists', () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(median([])).toBeNull();
		expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
		expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1)).toBe(1);
	});
});

describe('summarizeSpeed', () => {
	it('groups by provider and model, fastest output first', () => {
		const summary = summarizeSpeed([
			sample(),
			sample({ decodeMs: 5000 }),
			sample({ model: 'm2', decodeMs: 2500 }),
			sample({ providerId: 'p2', providerName: 'Cloud', model: 'm3', decodeMs: 20_000 }),
			sample({ providerId: 'p2', providerName: 'Cloud', model: 'm4', outputTokens: 2 })
		]);
		expect(summary.overall.samples).toBe(5);
		expect(summary.models.map((m) => m.model)).toEqual(['m2', 'm1', 'm3', 'm4']);
		expect(summary.models[1]).toMatchObject({ outputTps: 75, outputSamples: 2, samples: 2 });
		expect(summary.models[3].outputTps).toBeNull();
		expect(summary.providers.map((p) => [p.providerId, p.models])).toEqual([
			['p1', 2],
			['p2', 2]
		]);
	});
});

describe('formatting', () => {
	it('formats speeds and durations compactly', () => {
		expect(formatTps(42.123)).toBe('42.1');
		expect(formatTps(312.4)).toBe('312');
		expect(formatTps(1234)).toBe('1.2k');
		expect(formatTps(null)).toBe('—');
		expect(formatMs(850)).toBe('850 ms');
		expect(formatMs(2400)).toBe('2.4 s');
	});
});

describe('context bands', () => {
	it('buckets calls by context size', () => {
		expect(contextBucket(500)).toBe(0);
		expect(contextBucket(2048)).toBe(1);
		expect(contextBucket(40_000)).toBe(3);
		expect(contextBucket(500_000)).toBe(4);
		expect(contextBucket(null)).toBeNull();
	});
	it('splits speed per context band and records the median context', () => {
		const stats = contextSpeedStats([
			sample({ inputTokens: 1000, decodeMs: 5000 }),
			sample({ inputTokens: 20_000, decodeMs: 20_000 }),
			sample({ inputTokens: 30_000, decodeMs: 20_000 })
		]);
		expect(stats.contextTokens).toBe(20_000);
		expect(stats.byContext[0]?.outputTps).toBe(100);
		expect(stats.byContext[1]).toBeNull();
		expect(stats.byContext[2]).toMatchObject({ outputTps: 25, samples: 2 });
		expect(formatTokensShort(6240)).toBe('6.2k');
		expect(formatTokensShort(131_072)).toBe('131k');
	});
});
