import { describe, expect, it } from 'vitest';
import { cacheTokens, computeCostUsd, computeUsageCostUsd } from './pricing.js';

const prices = { price_input: 3, price_output: 15 };

describe('computeUsageCostUsd', () => {
	it('matches computeCostUsd when no cache prices are set', () => {
		const usage = {
			inputTokens: 1000,
			outputTokens: 200,
			inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 }
		};
		expect(computeUsageCostUsd(prices, usage)).toBeCloseTo(computeCostUsd(3, 15, 1000, 200)!, 12);
	});

	it('prices cache reads and writes with their own prices', () => {
		const cost = computeUsageCostUsd(
			{ ...prices, price_cache_read: 0.3, price_cache_write: 3.75 },
			{
				inputTokens: 1000,
				outputTokens: 200,
				inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 }
			}
		);
		expect(cost).toBeCloseTo((100 * 3 + 800 * 0.3 + 100 * 3.75 + 200 * 15) / 1_000_000, 12);
	});

	it('derives uncached tokens when the provider omits noCacheTokens', () => {
		const cost = computeUsageCostUsd(
			{ ...prices, price_cache_read: 0 },
			{ inputTokens: 1000, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 900 } }
		);
		expect(cost).toBeCloseTo((100 * 3) / 1_000_000, 12);
	});

	it('treats missing token details as all-uncached input', () => {
		expect(
			computeUsageCostUsd({ ...prices, price_cache_read: 0 }, { inputTokens: 10, outputTokens: 1 })
		).toBeCloseTo((10 * 3 + 15) / 1_000_000, 12);
	});

	it('is null when a base price or token count is unknown', () => {
		expect(computeUsageCostUsd(null, { inputTokens: 1, outputTokens: 1 })).toBeNull();
		expect(
			computeUsageCostUsd(
				{ price_input: 1, price_output: null },
				{ inputTokens: 1, outputTokens: 1 }
			)
		).toBeNull();
		expect(computeUsageCostUsd(prices, { inputTokens: 1 })).toBeNull();
		expect(computeUsageCostUsd(prices, null)).toBeNull();
	});
});

describe('cacheTokens', () => {
	it('extracts reported cache counts, null otherwise', () => {
		expect(
			cacheTokens({ inputTokenDetails: { cacheReadTokens: 5, cacheWriteTokens: undefined } })
		).toEqual({ cacheReadTokens: 5, cacheWriteTokens: null });
		expect(cacheTokens(null)).toEqual({ cacheReadTokens: null, cacheWriteTokens: null });
	});
});
