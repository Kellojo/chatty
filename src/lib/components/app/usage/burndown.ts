// Burn-down of one plan-limit window over a time range: what was left over time (across
// resets), where the current window is heading at its pace, and what the next reset gives back.
// Client-safe and pure, so it re-derives as the clock ticks.

import type { CodingUsageLimitWindow } from '$lib/coding-environments.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One synced reading of a window (`used` in percent). */
export interface LimitHistorySample {
	at: number;
	used: number;
	resetsAt: number | null;
}

export interface BurndownPoint {
	at: number;
	/** Percent left, 0–100. */
	remaining: number;
}

export interface Burndown {
	/** Start of the x-axis: the first point in the range. */
	start: number;
	/** End of the x-axis: the coming reset when the range reaches now, else the last point. */
	end: number;
	resetsAt: number | null;
	/**
	 * What was left over the range, oldest first: readings, plus jumps back to 100% at
	 * each reset and a 100% anchor when the first window began inside the range. Empty
	 * when the range holds no readings.
	 */
	points: BurndownPoint[];
	/**
	 * When `points` starts on an inferred 100% at the window start (no reading then), the
	 * first real reading: the stretch before it is assumed, not history. Null otherwise.
	 */
	assumedUntil: number | null;
	remainingNow: number;
	checkedAt: number;
	/** Past its reset time: the reading predates the reset and is stale until the next sync. */
	expired: boolean;
	/** Average burn of the current window since it began, in percentage points per hour. */
	pacePerHour: number | null;
	/** Where the current average pace leads, from the latest reading; null without a pace. */
	projection: {
		points: BurndownPoint[];
		/** Percent left at the reset at this pace (0 when it runs out first). */
		remainingAtReset: number;
		/** When it hits 0% at this pace, if that is before the reset. */
		runsOutAt: number | null;
	} | null;
}

/** Key of a window's history in `SubscriptionUsage.limitHistory`. */
export function limitHistoryKey(w: {
	environmentId: string;
	accountId: string;
	windowId: string;
}): string {
	return `${w.environmentId}:${w.accountId}:${w.windowId}`;
}

/** A first reading this soon after the window start makes the 100% anchor history-grade. */
const ASSUMED_GAP_MS = 30 * MINUTE;

/** Readings this far apart in `resetsAt` belong to different windows. */
const SAME_RESET_TOLERANCE_MS = HOUR;

/** When a window that resets at `resetsAt` began, from its kind; null if unknown. */
export function windowStart(
	kind: CodingUsageLimitWindow['windowKind'],
	resetsAt: number
): number | null {
	if (kind === 'session') return resetsAt - 5 * HOUR;
	if (kind === 'weekly') return resetsAt - 7 * DAY;
	if (kind === 'monthly') {
		const d = new Date(resetsAt);
		d.setMonth(d.getMonth() - 1);
		return d.getTime();
	}
	return null;
}

const clampPercent = (v: number) => Math.min(100, Math.max(0, v));

/** `points` up to `end`, with the segment crossing it cut at `end`. */
function clipPoints(points: BurndownPoint[], end: number): BurndownPoint[] {
	const out: BurndownPoint[] = [];
	for (const [i, p] of points.entries()) {
		if (p.at <= end) {
			out.push(p);
			continue;
		}
		const a = points[i - 1];
		if (a && a.at < end) {
			const t = (end - a.at) / (p.at - a.at);
			out.push({ at: end, remaining: a.remaining + (p.remaining - a.remaining) * t });
		}
		break;
	}
	return out;
}

/** The selected time range; open ends are unbounded. */
export interface BurndownRange {
	from?: number;
	to?: number;
}

export function buildBurndown(
	window: CodingUsageLimitWindow,
	history: LimitHistorySample[],
	now: number,
	range: BurndownRange = {}
): Burndown {
	const { resetsAt, checkedAt, windowKind } = window;
	const from = range.from ?? -Infinity;
	// The range reaches the latest reading, so the current window and its pace belong in it.
	const live = (range.to ?? Infinity) >= checkedAt;
	const sameWindow = (a: number | null, b: number | null) =>
		a === null ? b === null : b !== null && Math.abs(a - b) <= SAME_RESET_TOLERANCE_MS;

	const samples = history
		.filter((s) => s.at >= from && s.at <= Math.min(range.to ?? Infinity, checkedAt))
		.sort((a, b) => a.at - b.at);
	if (live && samples.at(-1)?.at !== checkedAt) {
		samples.push({ at: checkedAt, used: window.usedPercent, resetsAt });
	}

	// Readings in order; where a window reset between two of them, the line holds the last
	// reading until the reset, jumps back to full, and stays there until the next window began.
	const points: BurndownPoint[] = [];
	let prev: LimitHistorySample | null = null;
	for (const s of samples) {
		if (
			prev &&
			prev.resetsAt !== null &&
			prev.resetsAt <= s.at &&
			!sameWindow(prev.resetsAt, s.resetsAt)
		) {
			points.push({ at: prev.resetsAt, remaining: clampPercent(100 - prev.used) });
			points.push({ at: prev.resetsAt, remaining: 100 });
			const began = s.resetsAt !== null ? windowStart(windowKind, s.resetsAt) : null;
			if (began !== null && began > prev.resetsAt && began < s.at) {
				points.push({ at: began, remaining: 100 });
			}
		}
		points.push({ at: s.at, remaining: clampPercent(100 - s.used) });
		prev = s;
	}

	// Every window starts full; anchor the first one there when it began inside the range.
	// Within about a sync of its start the anchor is as good as a reading; beyond that the
	// stretch up to the first reading is only assumed.
	let assumedUntil: number | null = null;
	const first = samples[0];
	if (first) {
		const firstReset = sameWindow(first.resetsAt, resetsAt) ? resetsAt : first.resetsAt;
		const began = firstReset !== null ? windowStart(windowKind, firstReset) : null;
		if (began !== null && began >= from && began < first.at) {
			points.unshift({ at: began, remaining: 100 });
			if (first.at - began > ASSUMED_GAP_MS) assumedUntil = first.at;
		}
	}

	const start = points[0]?.at ?? range.from ?? checkedAt;
	const lastAt = points.at(-1)?.at ?? start;
	// The coming reset ends the axis, but the look ahead never outgrows the range shown, so
	// a short range isn't swamped by days of projection (the header still names the reset).
	const end =
		live && resetsAt !== null && resetsAt > lastAt
			? Math.min(resetsAt, lastAt + Math.max(lastAt - start, HOUR))
			: Math.max(lastAt, start + 1);
	const remainingNow = clampPercent(100 - window.usedPercent);
	const expired = resetsAt !== null && resetsAt <= now;

	// Average pace since the current window began (or its first reading): steadier than the
	// last interval, which swings with every burst of work.
	let projection: Burndown['projection'] = null;
	let pacePerHour: number | null = null;
	const knownStart = resetsAt !== null ? windowStart(windowKind, resetsAt) : null;
	const firstOfWindow = history
		.filter((s) => s.at <= checkedAt && sameWindow(s.resetsAt, resetsAt))
		.reduce<LimitHistorySample | null>((a, s) => (!a || s.at < a.at ? s : a), null);
	const paceFrom: BurndownPoint =
		knownStart !== null && knownStart <= checkedAt
			? { at: knownStart, remaining: 100 }
			: firstOfWindow
				? { at: firstOfWindow.at, remaining: clampPercent(100 - firstOfWindow.used) }
				: { at: checkedAt, remaining: remainingNow };
	const elapsed = checkedAt - paceFrom.at;
	if (live && !expired && resetsAt !== null && resetsAt > checkedAt && elapsed >= 10 * MINUTE) {
		const ratePerMs = Math.max(0, paceFrom.remaining - remainingNow) / elapsed;
		pacePerHour = ratePerMs * HOUR;
		const atReset = remainingNow - ratePerMs * (resetsAt - checkedAt);
		const runsOutAt =
			atReset < 0 && ratePerMs > 0 ? Math.round(checkedAt + remainingNow / ratePerMs) : null;
		projection = {
			points: [
				{ at: checkedAt, remaining: remainingNow },
				runsOutAt !== null
					? { at: runsOutAt, remaining: 0 }
					: { at: resetsAt, remaining: clampPercent(atReset) }
			],
			remainingAtReset: clampPercent(atReset),
			runsOutAt
		};
		if (runsOutAt !== null) projection.points.push({ at: resetsAt, remaining: 0 });
		projection.points = clipPoints(projection.points, end);
	}

	return {
		start,
		end,
		resetsAt,
		points,
		assumedUntil,
		remainingNow,
		checkedAt,
		expired,
		projection,
		pacePerHour
	};
}

/** "2d 4h", "3h 12m", "45m" — the two largest units of a duration. */
export function formatDuration(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / MINUTE));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

const TICK_STEPS = [
	HOUR,
	2 * HOUR,
	3 * HOUR,
	6 * HOUR,
	12 * HOUR,
	DAY,
	2 * DAY,
	3 * DAY,
	4 * DAY,
	7 * DAY,
	14 * DAY,
	28 * DAY
];

/** Local midnight (day steps) or whole hour (hour steps) at or after `at`. */
function ceilToStep(at: number, step: number): number {
	const d = new Date(at);
	if (step >= DAY) {
		d.setHours(0, 0, 0, 0);
		if (d.getTime() < at) d.setDate(d.getDate() + 1);
		return d.getTime();
	}
	const hours = step / HOUR;
	d.setMinutes(0, 0, 0);
	if (d.getTime() < at) d.setHours(d.getHours() + 1);
	while (d.getHours() % hours !== 0) d.setHours(d.getHours() + 1);
	return d.getTime();
}

/**
 * Round time ticks inside `[start, end]`: whole hours for short windows, local
 * midnights for longer ones, at most `maxTicks` of them, with a label format to match.
 */
export function burndownTicks(
	start: number,
	end: number,
	maxTicks: number
): { ticks: number[]; format: (at: number) => string } {
	const span = Math.max(1, end - start);
	// At most ~10 labels however wide, and whole days once the span passes two days (hour
	// labels would repeat without saying which day they are on).
	const limit = Math.min(10, Math.max(1, maxTicks));
	const step =
		TICK_STEPS.find((s) => span / s <= limit && (s >= DAY || span <= 2 * DAY)) ??
		TICK_STEPS.at(-1)!;
	const ticks: number[] = [];
	for (let t = ceilToStep(start, step); t <= end;) {
		ticks.push(t);
		const d = new Date(t);
		if (step >= DAY) d.setDate(d.getDate() + step / DAY);
		else d.setHours(d.getHours() + step / HOUR);
		t = d.getTime();
	}
	const fmt = new Intl.DateTimeFormat(
		undefined,
		step < DAY
			? { hour: 'numeric' }
			: // Weekdays only while they can't repeat; dates beyond a week.
				span <= 8 * DAY
				? { weekday: 'short' }
				: { month: 'short', day: 'numeric' }
	);
	return { ticks, format: (at) => fmt.format(at) };
}

/** Tooltip/label time: weekday and time, plus the date for windows longer than a week. */
export function formatBurndownTime(at: number, span: number): string {
	return new Intl.DateTimeFormat(undefined, {
		weekday: 'short',
		month: span > 8 * DAY ? 'short' : undefined,
		day: span > 8 * DAY ? 'numeric' : undefined,
		hour: 'numeric',
		minute: '2-digit'
	}).format(at);
}
