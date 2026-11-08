import { describe, expect, it } from 'vitest';
import type { CodingUsageLimitWindow } from '$lib/coding-environments.js';
import {
	billedParts,
	constrainingWindow,
	distinctUsageAccounts,
	groupUsageAccounts,
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

describe('plan limit accounts', () => {
	const now = 1_000_000;
	const win = (o: Partial<CodingUsageLimitWindow> = {}): CodingUsageLimitWindow => ({
		environmentId: 'e1',
		accountId: 'a1',
		provider: 'claude',
		accountLabel: 'Claude',
		accountEmail: 'me@x.test',
		accountPlan: 'Max',
		windowId: 'w',
		windowKind: 'weekly',
		windowLabel: 'Weekly',
		usedPercent: 10,
		resetsAt: now + 1000,
		checkedAt: now,
		...o
	});

	it('groups windows per environment account', () => {
		const accounts = groupUsageAccounts(
			[win(), win({ windowId: 'w2' }), win({ environmentId: 'e2' })],
			new Map([['e1', 'Devbox']])
		);
		expect(accounts.map((a) => [a.key, a.environmentName, a.windows.length])).toEqual([
			['e1:a1', 'Devbox', 2],
			['e2:a1', '', 1]
		]);
	});

	it('picks the live window closest to its cap, else the most used stale one', () => {
		const [account] = groupUsageAccounts(
			[
				win({ windowId: 'session', usedPercent: 40 }),
				win({ windowId: 'weekly', usedPercent: 70 }),
				win({ windowId: 'old', usedPercent: 99, resetsAt: now - 1 })
			],
			new Map()
		);
		expect(constrainingWindow(account, now)?.windowId).toBe('weekly');
		const [stale] = groupUsageAccounts(
			[
				win({ windowId: 'a', usedPercent: 30, resetsAt: now - 1 }),
				win({ windowId: 'b', usedPercent: 50, resetsAt: now - 1 })
			],
			new Map()
		);
		expect(constrainingWindow(stale, now)?.windowId).toBe('b');
	});

	it('shows a login seen through several environments once, keeping the latest', () => {
		const accounts = groupUsageAccounts(
			[
				win({ environmentId: 'e1', checkedAt: now }),
				win({ environmentId: 'e2', accountEmail: 'ME@x.test', checkedAt: now + 5 }),
				win({ environmentId: 'e3', accountEmail: null })
			],
			new Map()
		);
		expect(distinctUsageAccounts(accounts).map((a) => a.key)).toEqual(['e2:a1', 'e3:a1']);
	});
});
