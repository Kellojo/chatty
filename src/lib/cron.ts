import cronstrue from 'cronstrue';
import type { TimeFormat } from '$lib/user-settings.js';

export function describeCron(cron: string | undefined, timeFormat: TimeFormat): string | null {
	if (!cron) return null;
	try {
		return cronstrue.toString(cron, { use24HourTimeFormat: timeFormat === '24h' });
	} catch {
		return null;
	}
}

/** A schedule the friendly picker can edit; anything else stays a raw cron expression. */
export type ScheduleSpec =
	| { kind: 'minutes'; every: number }
	| { kind: 'hourly'; every: number; minute: number }
	| { kind: 'daily'; time: string }
	| { kind: 'weekly'; days: number[]; time: string }
	| { kind: 'monthly'; day: number; time: string };

export type ScheduleKind = ScheduleSpec['kind'];

/** Intervals that divide the hour/day evenly, so runs stay evenly spaced. */
export const MINUTE_INTERVALS = [1, 2, 5, 10, 15, 20, 30] as const;
export const HOUR_INTERVALS = [1, 2, 3, 4, 6, 8, 12] as const;

/** Weekdays in display order (Monday first) with their cron numbers. */
export const WEEKDAYS = [
	{ value: 1, short: 'Mon' },
	{ value: 2, short: 'Tue' },
	{ value: 3, short: 'Wed' },
	{ value: 4, short: 'Thu' },
	{ value: 5, short: 'Fri' },
	{ value: 6, short: 'Sat' },
	{ value: 0, short: 'Sun' }
] as const;

export function defaultSchedule(kind: ScheduleKind): ScheduleSpec {
	switch (kind) {
		case 'minutes':
			return { kind, every: 30 };
		case 'hourly':
			return { kind, every: 1, minute: 0 };
		case 'daily':
			return { kind, time: '09:00' };
		case 'weekly':
			return { kind, days: [1, 2, 3, 4, 5], time: '09:00' };
		case 'monthly':
			return { kind, day: 1, time: '09:00' };
	}
}

function splitTime(time: string): [number, number] {
	const [h, m] = time.split(':').map(Number);
	return [Number.isInteger(h) ? h : 0, Number.isInteger(m) ? m : 0];
}

/** Comma list of days, with runs of three or more collapsed to a range (1-5). */
function formatDays(days: number[]): string {
	const sorted = [...new Set(days)].sort((a, b) => a - b);
	const parts: string[] = [];
	for (let i = 0; i < sorted.length;) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
		if (j - i >= 2) parts.push(`${sorted[i]}-${sorted[j]}`);
		else for (let k = i; k <= j; k++) parts.push(String(sorted[k]));
		i = j + 1;
	}
	return parts.join(',');
}

export function buildCron(spec: ScheduleSpec): string {
	switch (spec.kind) {
		case 'minutes':
			return spec.every === 1 ? '* * * * *' : `*/${spec.every} * * * *`;
		case 'hourly':
			return `${spec.minute} ${spec.every === 1 ? '*' : `*/${spec.every}`} * * *`;
		case 'daily': {
			const [h, m] = splitTime(spec.time);
			return `${m} ${h} * * *`;
		}
		case 'weekly': {
			const [h, m] = splitTime(spec.time);
			return `${m} ${h} * * ${formatDays(spec.days)}`;
		}
		case 'monthly': {
			const [h, m] = splitTime(spec.time);
			return `${m} ${h} ${spec.day} * *`;
		}
	}
}

function int(field: string, min: number, max: number): number | null {
	if (!/^\d{1,2}$/.test(field)) return null;
	const value = Number(field);
	return value >= min && value <= max ? value : null;
}

function step(field: string): number | null {
	if (field === '*') return 1;
	const match = /^\*\/(\d{1,2})$/.exec(field);
	return match ? Number(match[1]) : null;
}

function parseDays(field: string): number[] | null {
	const days = new Set<number>();
	for (const part of field.split(',')) {
		const range = /^(\d)-(\d)$/.exec(part);
		const [from, to] = range
			? [Number(range[1]), Number(range[2])]
			: [int(part, 0, 7), int(part, 0, 7)];
		if (from === null || to === null || from > to || to > 7) return null;
		for (let d = from; d <= to; d++) days.add(d % 7);
	}
	return [...days];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Reads a cron expression back into a picker schedule, or null when only raw cron can express it. */
export function parseCron(cron: string): ScheduleSpec | null {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) return null;
	const [min, hour, dom, month, dow] = fields;
	if (month !== '*') return null;

	if (hour === '*' && dom === '*' && dow === '*') {
		const every = step(min);
		if (every !== null && (MINUTE_INTERVALS as readonly number[]).includes(every))
			return { kind: 'minutes', every };
	}

	const minute = int(min, 0, 59);
	if (minute === null) return null;

	if (dom === '*' && dow === '*') {
		const every = step(hour);
		if (every !== null && (HOUR_INTERVALS as readonly number[]).includes(every))
			return { kind: 'hourly', every, minute };
	}

	const h = int(hour, 0, 23);
	if (h === null) return null;
	const time = `${pad(h)}:${pad(minute)}`;

	if (dom === '*' && dow === '*') return { kind: 'daily', time };
	if (dom === '*') {
		const days = parseDays(dow);
		return days ? { kind: 'weekly', days, time } : null;
	}
	if (dow === '*') {
		const day = int(dom, 1, 31);
		return day === null ? null : { kind: 'monthly', day, time };
	}
	return null;
}
