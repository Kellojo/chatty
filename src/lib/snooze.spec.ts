import { describe, expect, it } from 'vitest';
import {
	formatSnoozeTime,
	fromDateTimeInput,
	isSnoozed,
	MAX_SNOOZE_MS,
	snoozeOptions,
	snoozeTimeError,
	toDateTimeInput
} from './snooze.js';

const at = (y: number, m: number, d: number, h: number, min = 0) =>
	new Date(y, m - 1, d, h, min, 0, 0);

describe('snoozeOptions', () => {
	it('offers every preset on a weekday morning, soonest first', () => {
		// Thursday 2026-11-12, 10:00.
		const options = snoozeOptions(at(2026, 11, 12, 10));
		expect(options.map((o) => o.label)).toEqual([
			'In 1 hour',
			'In 3 hours',
			'This evening',
			'Tomorrow',
			'Next week'
		]);
		expect(options[2].until).toBe(at(2026, 11, 12, 18).getTime());
		expect(options[3].until).toBe(at(2026, 11, 13, 9).getTime());
		expect(options[4].until).toBe(at(2026, 11, 16, 9).getTime());
	});

	it('drops this evening once it has passed', () => {
		const options = snoozeOptions(at(2026, 11, 12, 19));
		expect(options.map((o) => o.label)).not.toContain('This evening');
	});

	it('drops a preset that wakes in the same minute as an earlier one', () => {
		// 15:00 + 3h = 18:00, the same as "This evening".
		const options = snoozeOptions(at(2026, 11, 12, 15));
		expect(options.filter((o) => o.until === at(2026, 11, 12, 18).getTime())).toHaveLength(1);
	});

	it('means next week on a Monday', () => {
		const monday = snoozeOptions(at(2026, 11, 16, 8)).find((o) => o.label === 'Next week');
		expect(monday?.until).toBe(at(2026, 11, 23, 9).getTime());
	});

	it('reaches Monday from Sunday', () => {
		const sunday = snoozeOptions(at(2026, 11, 15, 12));
		const tomorrow = sunday.find((o) => o.label === 'Tomorrow');
		expect(tomorrow?.until).toBe(at(2026, 11, 16, 9).getTime());
		// Monday 9:00 is "Tomorrow" already, so "Next week" is folded into it.
		expect(sunday.map((o) => o.label)).not.toContain('Next week');
	});
});

describe('formatSnoozeTime', () => {
	const now = at(2026, 11, 12, 10);

	it('shows only the time today and names tomorrow and later days', () => {
		const time = (d: Date) =>
			d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
		expect(formatSnoozeTime(at(2026, 11, 12, 18), now)).toBe(time(at(2026, 11, 12, 18)));
		expect(formatSnoozeTime(at(2026, 11, 13, 9), now)).toBe(
			`Tomorrow ${time(at(2026, 11, 13, 9))}`
		);
		const monday = at(2026, 11, 16, 9);
		expect(formatSnoozeTime(monday, now)).toBe(
			`${monday.toLocaleDateString(undefined, { weekday: 'short' })} ${time(monday)}`
		);
		expect(formatSnoozeTime(at(2026, 12, 1, 9), now)).toContain(',');
	});
});

describe('isSnoozed', () => {
	it('is true only before the wake time', () => {
		expect(isSnoozed({ snoozedUntil: null }, 5)).toBe(false);
		expect(isSnoozed({ snoozedUntil: 10 }, 5)).toBe(true);
		expect(isSnoozed({ snoozedUntil: 10 }, 10)).toBe(false);
	});
});

describe('custom snooze time', () => {
	it('round-trips a local datetime-local value', () => {
		const ms = at(2026, 11, 13, 9, 30).getTime();
		expect(toDateTimeInput(ms)).toBe('2026-11-13T09:30');
		expect(fromDateTimeInput('2026-11-13T09:30')).toBe(ms);
		expect(fromDateTimeInput('2026-11-13')).toBeNull();
		expect(fromDateTimeInput('')).toBeNull();
	});

	it('accepts only a time ahead and within a year', () => {
		const now = at(2026, 11, 12, 10).getTime();
		expect(snoozeTimeError(null, now)).toMatch(/date and time/);
		expect(snoozeTimeError(now - 1, now)).toMatch(/future/);
		expect(snoozeTimeError(now + MAX_SNOOZE_MS + 1, now)).toMatch(/year/);
		expect(snoozeTimeError(now + 60_000, now)).toBeNull();
	});
});
