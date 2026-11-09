/**
 * Pure time-zone math for the ```clock widget, all via Intl so it runs in the
 * browser against the viewer's own zone and locale.
 */

export type Phase = 'dawn' | 'day' | 'dusk' | 'night';

export type ZoneTime = {
	/** Wall-clock parts in the zone. */
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	/** Offset from UTC in minutes (e.g. 330 for India). */
	offset: number;
	/** `YYYY-MM-DD` calendar date in the zone, for day comparisons. */
	dateKey: string;
};

const partsCache = new Map<string, Intl.DateTimeFormat>();
const timeCache = new Map<string, Intl.DateTimeFormat>();
const dateCache = new Map<string, Intl.DateTimeFormat>();

/** Viewer-locale formatter for `tz`, memoised per zone. */
function cached(
	cache: Map<string, Intl.DateTimeFormat>,
	tz: string,
	opts: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
	let f = cache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz });
		cache.set(tz, f);
	}
	return f;
}

function partsFormatter(tz: string): Intl.DateTimeFormat {
	let f = partsCache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric'
		});
		partsCache.set(tz, f);
	}
	return f;
}

/** Whether `tz` is an IANA zone (or alias) this browser knows. */
export function isValidZone(tz: unknown): tz is string {
	if (typeof tz !== 'string' || !tz.trim()) return false;
	try {
		partsFormatter(tz);
		return true;
	} catch {
		return false;
	}
}

/** Wall-clock time of `instant` in `tz`; null when the zone is unknown. */
export function zoneTime(instant: number, tz: string): ZoneTime | null {
	if (!isValidZone(tz)) return null;
	const get: Record<string, number> = {};
	for (const p of partsFormatter(tz).formatToParts(instant)) {
		if (p.type !== 'literal') get[p.type] = Number(p.value);
	}
	const { year, month, day, hour, minute, second } = get;
	const wall = Date.UTC(year, month - 1, day, hour % 24, minute, second);
	const floored = Math.floor(instant / 1000) * 1000;
	const offset = Math.round((wall - floored) / 60_000);
	const pad = (n: number) => String(n).padStart(2, '0');
	return {
		year,
		month,
		day,
		hour: hour % 24,
		minute,
		offset,
		dateKey: `${year}-${pad(month)}-${pad(day)}`
	};
}

/** Rough light phase by local hour; drives the tile's sky. */
export function phaseOf(hour: number, minute = 0): Phase {
	const h = hour + minute / 60;
	if (h >= 6 && h < 7.5) return 'dawn';
	if (h >= 7.5 && h < 17) return 'day';
	if (h >= 17 && h < 19) return 'dusk';
	return 'night';
}

const MINUS = '−';

/** "UTC+9", "UTC+5:30", "UTC−3:30", "UTC+0". */
export function formatOffset(minutes: number): string {
	if (minutes === 0) return 'UTC+0';
	const sign = minutes < 0 ? MINUS : '+';
	const abs = Math.abs(minutes);
	const h = Math.floor(abs / 60);
	const m = abs % 60;
	return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** "+8h", "−5h 30m", "+45m"; empty for zero. */
export function formatDiff(minutes: number): string {
	if (minutes === 0) return '';
	const sign = minutes < 0 ? MINUS : '+';
	const abs = Math.abs(minutes);
	const h = Math.floor(abs / 60);
	const m = abs % 60;
	return `${sign}${h ? `${h}h` : ''}${h && m ? ' ' : ''}${m ? `${m}m` : ''}`;
}

/** Whole calendar days from `fromKey` to `toKey` (both `YYYY-MM-DD`). */
export function dayDelta(fromKey: string, toKey: string): number {
	return Math.round(
		(Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 864e5
	);
}

/** City-ish label from an IANA zone: "America/Los_Angeles" -> "Los Angeles". */
export function zoneLabel(tz: string): string {
	return (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}

/** Time split into the clock digits and the day period ("3:00" + "PM"), in the viewer's locale. */
export function timeParts(instant: number, tz: string): { time: string; period: string } {
	const parts = cached(timeCache, tz, { hour: 'numeric', minute: '2-digit' }).formatToParts(
		instant
	);
	let time = '';
	let period = '';
	for (const p of parts) {
		if (p.type === 'dayPeriod') period = p.value;
		else time += p.value;
	}
	return { time: time.trim(), period };
}

/** "Tue, Nov 10" in the viewer's locale. */
export function dateLabel(instant: number, tz: string): string {
	return cached(dateCache, tz, { weekday: 'short', month: 'short', day: 'numeric' }).format(
		instant
	);
}

/** The viewer's own zone, falling back to UTC. */
export function viewerZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}
