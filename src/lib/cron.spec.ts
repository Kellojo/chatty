import { describe, expect, it } from 'vitest';
import {
	buildCron,
	defaultSchedule,
	describeCron,
	describeSchedule,
	parseCron,
	type ScheduleSpec
} from './cron.js';

describe('describeCron', () => {
	it('returns null for missing cron', () => {
		expect(describeCron(undefined, 'auto')).toBeNull();
		expect(describeCron('', 'auto')).toBeNull();
	});

	it('returns null for invalid cron', () => {
		expect(describeCron('not a cron', 'auto')).toBeNull();
	});

	it('describes a valid cron expression', () => {
		expect(describeCron('*/30 * * * *', 'auto')).toBe('Every 30 minutes');
	});

	it('honours the 12h/24h time format', () => {
		expect(describeCron('0 9 * * *', '12h')).toBe('At 09:00 AM');
		expect(describeCron('0 9 * * *', 'auto')).toBe('At 09:00 AM');
		expect(describeCron('0 9 * * *', '24h')).toBe('At 09:00');
	});
});

describe('buildCron / parseCron', () => {
	const cases: [ScheduleSpec, string][] = [
		[{ kind: 'minutes', every: 1 }, '* * * * *'],
		[{ kind: 'minutes', every: 15 }, '*/15 * * * *'],
		[{ kind: 'hourly', every: 1, minute: 5 }, '5 * * * *'],
		[{ kind: 'hourly', every: 6, minute: 0 }, '0 */6 * * *'],
		[{ kind: 'daily', time: '09:30' }, '30 9 * * *'],
		[{ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '08:00' }, '0 8 * * 1-5'],
		[{ kind: 'weekly', days: [0, 6], time: '10:15' }, '15 10 * * 0,6'],
		[{ kind: 'weekly', days: [1, 3, 4, 5], time: '07:00' }, '0 7 * * 1,3-5'],
		[{ kind: 'monthly', day: 15, time: '00:00' }, '0 0 15 * *']
	];

	it.each(cases)('round-trips %o as %s', (spec, cron) => {
		expect(buildCron(spec)).toBe(cron);
		const parsed = parseCron(cron);
		if (parsed?.kind === 'weekly') parsed.days.sort((a, b) => a - b);
		const expected = spec.kind === 'weekly' ? { ...spec, days: [...spec.days].sort() } : spec;
		expect(parsed).toEqual(expected);
	});

	it('treats Sunday as 7 the same as 0', () => {
		expect(parseCron('0 9 * * 7')).toEqual({ kind: 'weekly', days: [0], time: '09:00' });
	});

	it('returns null for schedules only raw cron can express', () => {
		expect(parseCron('')).toBeNull();
		expect(parseCron('not a cron')).toBeNull();
		expect(parseCron('*/7 * * * *')).toBeNull();
		expect(parseCron('0 9 * 1 *')).toBeNull();
		expect(parseCron('0 9 1 * 1')).toBeNull();
		expect(parseCron('0,30 9 * * *')).toBeNull();
		expect(parseCron('0 9 * * MON-FRI')).toBeNull();
	});

	it('builds valid defaults for every kind', () => {
		for (const kind of ['minutes', 'hourly', 'daily', 'weekly', 'monthly'] as const) {
			expect(parseCron(buildCron(defaultSchedule(kind)))?.kind).toBe(kind);
		}
	});
});

describe('describeSchedule', () => {
	const cases: [ScheduleSpec, string][] = [
		[{ kind: 'minutes', every: 1 }, 'every minute'],
		[{ kind: 'minutes', every: 30 }, 'every 30 minutes'],
		[{ kind: 'hourly', every: 1, minute: 0 }, 'every hour, on the hour'],
		[{ kind: 'hourly', every: 2, minute: 15 }, 'every 2 hours, 15 min past the hour'],
		[
			{ kind: 'hourly', every: 6, minute: 15 },
			'every 6 hours, 15 min past the hour (00:15, 06:15, 12:15 and 18:15)'
		],
		[{ kind: 'daily', time: '09:00' }, 'every day at 09:00'],
		[{ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '08:30' }, 'every weekday at 08:30'],
		[{ kind: 'weekly', days: [6, 0], time: '10:00' }, 'on weekends at 10:00'],
		[{ kind: 'weekly', days: [1], time: '09:00' }, 'every Monday at 09:00'],
		[
			{ kind: 'weekly', days: [5, 1, 3], time: '09:00' },
			'on Mondays, Wednesdays and Fridays at 09:00'
		],
		[{ kind: 'monthly', day: 1, time: '09:00' }, 'on the 1st of every month at 09:00'],
		[
			{ kind: 'monthly', day: 31, time: '09:00' },
			'on the 31st of every month at 09:00, skipping months without one'
		]
	];

	it.each(cases)('describes %o', (spec, text) => {
		expect(describeSchedule(spec, '24h')).toBe(text);
	});

	it('uses 12h clock times unless 24h is set', () => {
		expect(describeSchedule({ kind: 'daily', time: '00:05' }, '12h')).toBe('every day at 12:05 AM');
		expect(describeSchedule({ kind: 'daily', time: '13:30' }, 'auto')).toBe('every day at 1:30 PM');
		expect(describeSchedule({ kind: 'monthly', day: 12, time: '09:00' }, '24h')).toContain('12th');
	});
});
