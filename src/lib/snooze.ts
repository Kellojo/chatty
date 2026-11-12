// Snooze presets and labels, shared by the sidebar and the chat header menu.
// The presets follow T3 Code's defaults: in 1 and 3 hours, this evening,
// tomorrow morning and next Monday morning.

export interface SnoozeOption {
	label: string;
	/** When the chat comes back, in ms. */
	until: number;
	/** Short wake time shown next to the label ("6:00 PM", "Mon 9:00 AM"). */
	when: string;
}

const HOUR_MS = 60 * 60 * 1000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

/** Local `hour`:00 on the day `days` after `now`'s. */
function atHour(now: Date, days: number, hour: number): Date {
	const d = new Date(now);
	d.setDate(d.getDate() + days);
	d.setHours(hour, 0, 0, 0);
	return d;
}

/**
 * The snooze presets still ahead of `now`, soonest first. A preset that has
 * passed for today ("This evening" at night) is left out, and so is one that
 * wakes in the same minute as an earlier one.
 */
export function snoozeOptions(now: Date = new Date()): SnoozeOption[] {
	// Days until next Monday, never today (a Monday snooze means next week).
	const toMonday = ((8 - now.getDay()) % 7 || 7) as number;
	const candidates: { label: string; at: Date }[] = [
		{ label: 'In 1 hour', at: new Date(now.getTime() + HOUR_MS) },
		{ label: 'In 3 hours', at: new Date(now.getTime() + 3 * HOUR_MS) },
		{ label: 'This evening', at: atHour(now, 0, EVENING_HOUR) },
		{ label: 'Tomorrow', at: atHour(now, 1, MORNING_HOUR) },
		{ label: 'Next week', at: atHour(now, toMonday, MORNING_HOUR) }
	];
	const seen = new Set<number>();
	return candidates
		.filter((c) => c.at.getTime() > now.getTime())
		.sort((a, b) => a.at.getTime() - b.at.getTime())
		.filter((c) => {
			const minute = Math.floor(c.at.getTime() / 60_000);
			if (seen.has(minute)) return false;
			seen.add(minute);
			return true;
		})
		.map((c) => ({ label: c.label, until: c.at.getTime(), when: formatSnoozeTime(c.at, now) }));
}

function sameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

/**
 * A wake time relative to `now`: just the time today, "Tomorrow 9:00 AM",
 * the weekday within a week, else the date.
 */
export function formatSnoozeTime(at: Date | number, now: Date = new Date()): string {
	const d = typeof at === 'number' ? new Date(at) : at;
	const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	if (sameDay(d, now)) return time;
	if (sameDay(d, atHour(now, 1, 0))) return `Tomorrow ${time}`;
	if (d.getTime() - now.getTime() < 6 * 24 * HOUR_MS) {
		return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
	}
	return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** Where the custom time picker starts: tomorrow morning. */
export function defaultCustomSnooze(now: Date = new Date()): number {
	return atHour(now, 1, MORNING_HOUR).getTime();
}

/** Longest snooze the server accepts. */
export const MAX_SNOOZE_MS = 366 * 24 * HOUR_MS;

const pad = (n: number) => String(n).padStart(2, '0');

/** `ms` as a local `datetime-local` input value ("2026-11-13T09:00"). */
export function toDateTimeInput(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A local `datetime-local` input value in ms, or null when it isn't a full date and time. */
export function fromDateTimeInput(value: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
	if (!m) return null;
	const [y, mo, d, h, mi] = m.slice(1).map(Number);
	const date = new Date(y, mo - 1, d, h, mi, 0, 0);
	return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** Why a custom snooze time can't be used, or null when it can. */
export function snoozeTimeError(until: number | null, now: number = Date.now()): string | null {
	if (until === null) return 'Pick a date and time.';
	if (until <= now) return 'Pick a time in the future.';
	if (until > now + MAX_SNOOZE_MS) return 'Pick a time within a year.';
	return null;
}

/** Whether the conversation is snoozed at `now`. */
export function isSnoozed(c: { snoozedUntil: number | null }, now: number = Date.now()): boolean {
	return c.snoozedUntil !== null && c.snoozedUntil > now;
}
