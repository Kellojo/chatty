import { describe, expect, it } from 'vitest';
import {
	billedParts,
	mostUsedWindow,
	remainingPercent,
	resetLabel,
	formatApiValue,
	formatDayShort,
	modelColors,
	parseUsagePeriod,
	periodQuery
} from './usage.js';

describe('usage period', () => {
	it('falls back to 30d and keeps the default out of the URL', () => {
		expect(parseUsagePeriod('7d')).toBe('7d');
		expect(parseUsagePeriod('bogus')).toBe('30d');
		expect(periodQuery('30d')).toBe('');
		expect(periodQuery('90d', { user: 'u1', provider: '' })).toBe('?period=90d&user=u1');
	});
});

describe('modelColors', () => {
	it('keeps a model on the same color whatever else is shown or filtered', () => {
		const all = [
			'qwen2.5-0.5b-instruct',
			'laya',
			'deepseek/deepseek-r1',
			'qwen/qwen3.8-27b',
			'LM Studio/laya'
		];
		const wide = modelColors([...all, 'Other'], all);
		for (const model of all) {
			expect(modelColors([model], all)[model]).toBe(wide[model]);
		}
		expect(wide.Other).toBe('var(--chart-other)');
	});

	it('gives distinct colors while the palette has room', () => {
		const all = ['a', 'b', 'c', 'd', 'e'];
		const colors = modelColors(all, all);
		expect(new Set(Object.values(colors)).size).toBe(5);
	});

	it('does not depend on the order models are listed in', () => {
		const all = ['x', 'y', 'z'];
		expect(modelColors(['z', 'x'], all)).toEqual(modelColors(['x', 'z'], [...all].reverse()));
	});

	it('keeps colors when the visible set is narrowed by a filter', () => {
		const all = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
		const everything = modelColors(all, all);
		expect(modelColors(['m6', 'm2'], all)).toEqual({ m6: everything.m6, m2: everything.m2 });
	});
});

describe('formatDayShort', () => {
	it('formats a day key without shifting it across time zones', () => {
		expect(formatDayShort('2026-10-12')).toMatch(/12/);
	});
});

describe('formatApiValue', () => {
	it('marks lower bounds and unpriced usage the same way everywhere', () => {
		expect(formatApiValue(736.444, false)).toBe('≈ $736.44');
		expect(formatApiValue(735.5, true)).toBe('≈ $735.50+');
		expect(formatApiValue(0, true)).toBe('Not priced');
		expect(formatApiValue(0, false)).toBe('≈ $0');
	});
});

describe('billedParts', () => {
	it('returns the value and a separate note, never a nested string', () => {
		expect(billedParts(0.00042, { precise: true })).toEqual({ value: '$0.00042', note: null });
		expect(billedParts(0, { pricedRequests: 3 })).toEqual({ value: '$0', note: null });
		const unknown = billedParts(null);
		expect(unknown.value).toBe('—');
		expect(unknown.note).toBe('No cost reported · no known price for this model');
		expect(billedParts(0, { pricedRequests: 0 }).value).toBe('—');
	});
});

describe('remainingPercent', () => {
	it('shows what is left of the window, clamped to 0–100', () => {
		const w = (usedPercent: number) => ({
			environmentId: 'e',
			accountId: 'a',
			provider: 'claude',
			accountLabel: 'Claude',
			accountEmail: null,
			accountPlan: null,
			windowId: 'w',
			windowKind: 'session' as const,
			windowLabel: 'Session',
			usedPercent,
			resetsAt: null,
			checkedAt: 0
		});
		expect(remainingPercent(w(0))).toBe(100);
		expect(remainingPercent(w(52.4))).toBe(48);
		expect(remainingPercent(w(100))).toBe(0);
		expect(remainingPercent(w(120))).toBe(0);
	});
});

describe('mostUsedWindow', () => {
	const now = Date.UTC(2026, 10, 7, 12);
	const win = (windowId: string, usedPercent: number, resetsAt: number | null) => ({
		environmentId: 'e',
		accountId: 'a',
		provider: 'claude',
		accountLabel: 'Claude',
		accountEmail: null,
		accountPlan: null,
		windowId,
		windowKind: 'session' as const,
		windowLabel: windowId,
		usedPercent,
		resetsAt,
		checkedAt: now - 3_600_000
	});
	const account = (windows: ReturnType<typeof win>[]) => ({
		key: 'e:a',
		environmentId: 'e',
		environmentName: 'pc',
		provider: 'claude',
		accountLabel: 'Claude',
		accountEmail: null,
		accountPlan: null,
		checkedAt: now,
		windows
	});

	it('skips windows whose reset time has passed (their percentage is stale)', () => {
		const accounts = [
			account([win('session', 81, now - 60_000), win('weekly', 40, now + 86_400_000)])
		];
		expect(mostUsedWindow(accounts, now)?.window.windowId).toBe('weekly');
		expect(mostUsedWindow([account([win('session', 81, now - 1)])], now)).toBeNull();
		expect(resetLabel(now - 1, now)).toBe('reset — awaiting sync');
	});
});
