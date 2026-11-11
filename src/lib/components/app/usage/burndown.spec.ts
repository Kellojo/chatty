import { describe, expect, it } from 'vitest';
import type { CodingUsageLimitWindow } from '$lib/coding-environments.js';
import { buildBurndown, formatDuration, windowStart } from './burndown.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RESET = Date.UTC(2026, 10, 14, 9);
const START = RESET - 7 * DAY;

const weekly = (overrides: Partial<CodingUsageLimitWindow> = {}): CodingUsageLimitWindow => ({
	environmentId: 'e',
	accountId: 'a',
	provider: 'claude',
	accountLabel: 'Claude',
	accountEmail: null,
	accountPlan: null,
	windowId: 'seven_day',
	windowKind: 'weekly',
	windowLabel: 'Weekly',
	usedPercent: 50,
	resetsAt: RESET,
	checkedAt: START + 2 * DAY,
	...overrides
});

describe('buildBurndown', () => {
	it('starts full, keeps to the range and projects a pace that runs out early', () => {
		const w = weekly();
		const b = buildBurndown(
			w,
			[
				{ at: START - DAY, used: 90, resetsAt: START }, // previous window
				{ at: START + DAY, used: 20, resetsAt: RESET + 60_000 } // jittered reset
			],
			w.checkedAt,
			{ from: START }
		);
		expect(b.points).toEqual([
			{ at: START, remaining: 100 },
			{ at: START + DAY, remaining: 80 },
			{ at: START + 2 * DAY, remaining: 50 }
		]);
		// 50% in 2 days → the other 50% lasts 2 more days, 3 days before the reset.
		expect(b.projection?.runsOutAt).toBe(START + 4 * DAY);
		expect(b.projection?.remainingAtReset).toBe(0);
		// The look ahead stops after as long as the range shown (2 days), before the reset.
		expect(b.end).toBe(START + 4 * DAY);
		expect(b.projection?.points.at(-1)).toEqual({ at: START + 4 * DAY, remaining: 0 });
	});

	it('projects what is left at the reset on a slow pace', () => {
		const w = weekly({ usedPercent: 10 });
		const b = buildBurndown(w, [], w.checkedAt);
		expect(b.projection?.runsOutAt).toBeNull();
		expect(b.projection?.remainingAtReset).toBeCloseTo(65);
	});

	it('flags a window past its reset and skips the projection', () => {
		const w = weekly();
		const b = buildBurndown(w, [], RESET + HOUR);
		expect(b.expired).toBe(true);
		expect(b.projection).toBeNull();
	});

	it('falls back to the first reading for windows of unknown length', () => {
		const w = weekly({ windowKind: 'other', checkedAt: START + 3 * DAY });
		expect(windowStart('other', RESET)).toBeNull();
		const b = buildBurndown(w, [{ at: START + DAY, used: 10, resetsAt: RESET }], w.checkedAt);
		expect(b.start).toBe(START + DAY);
		expect(b.points[0]).toEqual({ at: START + DAY, remaining: 90 });
	});
});

describe('buildBurndown over several windows', () => {
	it('jumps back to full at each reset and stays full until the next window began', () => {
		const w = weekly({ windowKind: 'session', resetsAt: RESET, checkedAt: RESET - 4 * HOUR });
		const prevReset = RESET - 10 * HOUR; // previous session: ended 10h before this one resets
		const b = buildBurndown(
			w,
			[
				{ at: prevReset - 2 * HOUR, used: 30, resetsAt: prevReset },
				{ at: prevReset - HOUR, used: 60, resetsAt: prevReset },
				{ at: RESET - 4.5 * HOUR, used: 20, resetsAt: RESET }
			],
			w.checkedAt
		);
		// Previous window starts full, resets, idles at 100% until this one began.
		expect(b.points).toEqual([
			{ at: prevReset - 5 * HOUR, remaining: 100 },
			{ at: prevReset - 2 * HOUR, remaining: 70 },
			{ at: prevReset - HOUR, remaining: 40 },
			{ at: prevReset, remaining: 40 },
			{ at: prevReset, remaining: 100 },
			{ at: RESET - 5 * HOUR, remaining: 100 },
			{ at: RESET - 4.5 * HOUR, remaining: 80 },
			{ at: RESET - 4 * HOUR, remaining: 50 }
		]);
		expect(b.end).toBe(RESET);
		// Pace counts from this window's start only: 50% in 1h, so it runs out within the hour.
		expect(b.projection?.runsOutAt).toBe(RESET - 3 * HOUR);
	});

	it('shows only readings inside a past range, without the current window or a pace', () => {
		const w = weekly({ checkedAt: START + 2 * DAY });
		const b = buildBurndown(
			w,
			[
				{ at: START - 3 * DAY, used: 40, resetsAt: START },
				{ at: START - 2 * DAY, used: 50, resetsAt: START }
			],
			w.checkedAt,
			{ from: START - 3 * DAY - HOUR, to: START - DAY }
		);
		expect(b.points.map((p) => p.remaining)).toEqual([60, 50]);
		expect(b.projection).toBeNull();
		expect(b.end).toBe(START - 2 * DAY);
		expect(buildBurndown(w, [], w.checkedAt, { to: START - DAY }).points).toEqual([]);
	});
});

describe('formatDuration', () => {
	it('shows the two largest units', () => {
		expect(formatDuration(45 * 60_000)).toBe('45m');
		expect(formatDuration(3 * HOUR + 12 * 60_000)).toBe('3h 12m');
		expect(formatDuration(2 * DAY + 4 * HOUR)).toBe('2d 4h');
		expect(formatDuration(DAY)).toBe('1d');
	});
});
