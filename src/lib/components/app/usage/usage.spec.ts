import { describe, expect, it } from 'vitest';
import { formatDayShort, modelColors, parseUsagePeriod, periodQuery } from './usage.js';

describe('usage period', () => {
	it('falls back to 30d and keeps the default out of the URL', () => {
		expect(parseUsagePeriod('7d')).toBe('7d');
		expect(parseUsagePeriod('bogus')).toBe('30d');
		expect(periodQuery('30d')).toBe('');
		expect(periodQuery('90d', { user: 'u1', provider: '' })).toBe('?period=90d&user=u1');
	});
});

describe('modelColors', () => {
	it('keeps a model on the same color whatever else is shown, without collisions', () => {
		const all = ['a', 'b', 'c', 'd', 'e', 'f'];
		const wide = modelColors(['f', 'b', 'Other'], all);
		const narrow = modelColors(['b'], all);
		expect(wide.b).toBe(narrow.b);
		expect(wide.f).not.toBe(wide.b);
		expect(wide.Other).toBe('var(--chart-other)');
	});
});

describe('formatDayShort', () => {
	it('formats a day key without shifting it across time zones', () => {
		expect(formatDayShort('2026-10-12')).toMatch(/12/);
	});
});
