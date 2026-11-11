import { describe, expect, it } from 'vitest';
import type { CodingUsageLimitWindow } from '$lib/coding-environments.js';
import { buildQuotaPool, simulateAccount, sumLines, upcomingResets } from './quota.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 11, 12);

const weekly = (o: Partial<CodingUsageLimitWindow> = {}): CodingUsageLimitWindow => ({
	environmentId: 'e',
	accountId: 'a',
	provider: 'claudeAgent',
	accountLabel: 'Claude',
	accountEmail: null,
	accountPlan: null,
	windowId: 'seven_day',
	windowKind: 'weekly',
	windowLabel: 'Weekly',
	usedPercent: 50,
	resetsAt: NOW + 2 * DAY,
	checkedAt: NOW,
	...o
});

describe('simulateAccount', () => {
	it('burns, runs dry, then refills to 100% at each reset', () => {
		const w = weekly({ usedPercent: 60 }); // 40% left at 1%/h: dry after 40h, reset at 48h
		const sim = simulateAccount(w, 1, NOW + 9 * DAY);
		expect(sim.emptyAt).toBe(NOW + 40 * HOUR);
		expect(sim.resets).toEqual([
			{ at: NOW + 2 * DAY, gain: 100 },
			{ at: NOW + 9 * DAY, gain: 100 }
		]);
		expect(sim.points.slice(0, 4)).toEqual([
			{ at: NOW, remaining: 40 },
			{ at: NOW + 40 * HOUR, remaining: 0 },
			{ at: NOW + 2 * DAY, remaining: 0 },
			{ at: NOW + 2 * DAY, remaining: 100 }
		]);
	});

	it('treats a reading from before a passed reset as refilled', () => {
		const w = weekly({ resetsAt: NOW - 3 * HOUR, checkedAt: NOW - 2 * HOUR, usedPercent: 90 });
		const sim = simulateAccount(w, 0, NOW + DAY);
		expect(sim.points[0]).toEqual({ at: NOW - 2 * HOUR, remaining: 100 });
		expect(sim.resets).toEqual([]);
		// A reset after the reading but before now still shows as a jump.
		const later = simulateAccount(
			weekly({ resetsAt: NOW - HOUR, checkedAt: NOW - 2 * HOUR, usedPercent: 90 }),
			0,
			NOW + DAY
		);
		expect(later.resets).toEqual([{ at: NOW - HOUR, gain: 90 }]);
	});
});

describe('sumLines', () => {
	it('adds lines at every breakpoint and keeps jumps', () => {
		const a = [
			{ at: 0, remaining: 50 },
			{ at: 10, remaining: 40 },
			{ at: 10, remaining: 100 }
		];
		const b = [
			{ at: 0, remaining: 20 },
			{ at: 20, remaining: 0 }
		];
		expect(sumLines([a, b], 0, 20)).toEqual([
			{ at: 0, remaining: 70 },
			{ at: 10, remaining: 50 },
			{ at: 10, remaining: 110 },
			{ at: 20, remaining: 100 }
		]);
	});
});

describe('buildQuotaPool', () => {
	it('pools accounts, sums burn and finds when the pool and the first account run dry', () => {
		const accounts = [
			{ key: 'a', label: 'A', window: weekly({ usedPercent: 50 }), history: [] },
			{
				key: 'b',
				label: 'B',
				window: weekly({ accountId: 'b', usedPercent: 0, resetsAt: NOW + 6 * DAY }),
				history: []
			}
		];
		const pool = buildQuotaPool(accounts, NOW);
		expect(pool.capacity).toBe(200);
		expect(pool.remaining).toBe(150);
		// A used 50% in 5 days (10%/day); B nothing yet.
		expect(pool.burnPerHour).toBeCloseTo(10 / 24);
		expect(pool.resets[0]).toEqual({ at: NOW + 2 * DAY, gain: 70 });
		expect(pool.firstEmptyAt).toBeNull();
		expect(pool.emptyEarly).toEqual([]);
		expect(pool.projected[0]).toEqual({ at: NOW, remaining: 150 });
	});

	it('has no projection for a range that ended in the past', () => {
		const pool = buildQuotaPool([{ key: 'a', label: 'A', window: weekly(), history: [] }], NOW, {
			to: NOW - DAY
		});
		expect(pool.projected).toEqual([]);
		expect(pool.resets).toEqual([]);
	});
});

describe('buildQuotaPool emptyEarly', () => {
	it('names an account that runs dry before its own reset', () => {
		// 90% used in 5 days (18%/day): the last 10% lasts ~13h, the reset is 2 days out.
		const pool = buildQuotaPool(
			[{ key: 'a', label: 'Claude', window: weekly({ usedPercent: 90 }), history: [] }],
			NOW
		);
		expect(pool.emptyEarly).toEqual([
			{ key: 'a', label: 'Claude', at: NOW + (40 * 3_600_000) / 3, resetAt: NOW + 2 * DAY }
		]);
	});
});

describe('upcomingResets', () => {
	it('lists every live window soonest first with what it gives back', () => {
		const resets = upcomingResets(
			[
				{ accountLabel: 'Claude', window: weekly() },
				{
					accountLabel: 'Claude',
					window: weekly({
						windowId: 'five_hour',
						windowKind: 'session',
						windowLabel: 'Session',
						usedPercent: 30,
						resetsAt: NOW + HOUR
					})
				},
				{ accountLabel: 'Claude', window: weekly({ windowId: 'old', resetsAt: NOW - HOUR }) }
			],
			NOW
		);
		expect(resets.map((r) => r.windowLabel)).toEqual(['Session', 'Weekly']);
		// Session: 30% in 4h → 7.5%/h, so 37.5% used by the reset an hour out.
		expect(resets[0]).toMatchObject({ left: 70, gain: 38 });
	});
});
