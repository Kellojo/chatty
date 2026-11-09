/**
 * Payload parsing for the ```events widget: concerts, festivals, games,
 * shows… anything with a date. Times are kept as the wall-clock time at the
 * venue: `2026-11-14T20:00` stays 20:00, while an instant with an offset
 * (`…Z`, `…+01:00`) is shown in the payload's `timeZone` (or the viewer's).
 */

import { isoDay } from './mealplan-payload.js';

export type EventStatus = 'soldout' | 'few' | 'cancelled' | 'postponed' | 'free';

export type Moment = { date: string; time: string | null };

export type EventItem = {
	key: string;
	title: string;
	start: Moment;
	end: Moment | null;
	venue: string | null;
	city: string | null;
	lineup: string[];
	category: string | null;
	image: string | null;
	url: string | null;
	price: string | null;
	status: EventStatus | null;
	doors: string | null;
	/** Only when the payload says so: a missing time means "unknown", not "all day". */
	allDay: boolean;
	notes: string | null;
};

export type EventMonth = { key: string; events: EventItem[] };

export type EventList = {
	title: string | null;
	events: EventItem[];
	months: EventMonth[];
	total: number;
	/** The payload's (valid) venue zone, so "today" is judged where the events happen. */
	timeZone: string | null;
};

const MAX_EVENTS = 30;
const MAX_LINEUP = 6;

const rec = (v: unknown): Record<string, unknown> | null =>
	typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null =>
	typeof v === 'string' && v.trim()
		? v.replace(/\s+/g, ' ').trim()
		: typeof v === 'number'
			? String(v)
			: null;

function webUrl(v: unknown): string | null {
	const s = str(v);
	return s && URL.canParse(s) && /^https?:$/.test(new URL(s).protocol) ? new URL(s).href : null;
}

function imageUrl(v: unknown): string | null {
	const s = str(v);
	if (s && /^data:image\//i.test(s)) return s;
	return webUrl(s);
}

const TIME_RE = /^(\d{1,2}):(\d{2})/;

function hhmm(v: unknown): string | null {
	const m = typeof v === 'string' ? TIME_RE.exec(v.trim()) : null;
	return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

function isValidZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat('en', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** A date, a wall-clock date-time, or an instant (with offset) converted into `timeZone`. */
export function parseMoment(v: unknown, timeZone?: string): Moment | null {
	const s = typeof v === 'string' ? v.trim() : '';
	const date = isoDay(s);
	if (!date) return null;
	const rest = s.slice(10);
	if (!rest) return { date, time: null };
	if (!/^[T ]\d{1,2}:\d{2}/.test(rest)) return null;
	if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(rest)) {
		const at = Date.parse(s.replace(' ', 'T'));
		if (Number.isNaN(at)) return null;
		const parts = Object.fromEntries(
			new Intl.DateTimeFormat('en-CA', {
				timeZone,
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				hourCycle: 'h23'
			})
				.formatToParts(at)
				.map((p) => [p.type, p.value])
		);
		return {
			date: `${parts.year}-${parts.month}-${parts.day}`,
			time: `${parts.hour}:${parts.minute}`
		};
	}
	return { date, time: hhmm(rest.slice(1)) };
}

function statusOf(v: unknown, price: string | null): EventStatus | null {
	const s = str(v)
		?.toLowerCase()
		.replace(/[\s_-]+/g, '');
	if (s) {
		if (/soldout|ausverkauft/.test(s)) return 'soldout';
		if (/few|limited|lastticket|almost/.test(s)) return 'few';
		if (/cancel|abgesagt/.test(s)) return 'cancelled';
		if (/postpone|verschoben|rescheduled/.test(s)) return 'postponed';
		if (/^free$/.test(s)) return 'free';
	}
	return price && /^(free|kostenlos|gratis|0([.,]00)?\s*\D*)$/i.test(price) ? 'free' : null;
}

function lineupOf(v: unknown): string[] {
	const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\s*[,;]\s*/) : [];
	return list
		.map((a) => str(a) ?? str(rec(a)?.name))
		.filter((a): a is string => a !== null)
		.slice(0, MAX_LINEUP);
}

function parseEvent(v: unknown, i: number, timeZone: string | undefined): EventItem | null {
	const e = rec(v);
	if (!e) return null;
	const title = str(e.title) ?? str(e.name);
	const start = parseMoment(e.start ?? e.date ?? e.startDate, timeZone);
	if (!title || !start) return null;
	// A separate `time` field ("20:00") completes a date-only start.
	if (!start.time && e.allDay !== true) start.time = hhmm(e.time ?? e.startTime);
	if (e.allDay === true) start.time = null;
	let end = parseMoment(e.end ?? e.endDate, timeZone);
	if (!end && hhmm(e.endTime)) end = { date: start.date, time: hhmm(e.endTime) };
	if (end && (end.date < start.date || (end.date === start.date && end.time === start.time)))
		end = null;
	const venueRec = rec(e.venue) ?? rec(e.location);
	const price = str(e.price);
	return {
		key: str(e.id) ?? `${start.date}-${i}`,
		title,
		start,
		end,
		venue: str(venueRec?.name) ?? str(e.venue) ?? str(e.location),
		city: str(venueRec?.city) ?? str(e.city),
		lineup: lineupOf(e.lineup ?? e.artists ?? e.performers ?? e.support).filter(
			(a) => a.toLowerCase() !== title.toLowerCase()
		),
		category: str(e.category) ?? str(e.type),
		image: imageUrl(e.image),
		url: webUrl(e.url ?? e.tickets ?? e.ticketUrl ?? e.link),
		price,
		status: statusOf(e.status, price),
		doors: hhmm(e.doors),
		allDay: e.allDay === true,
		notes: str(e.notes) ?? str(e.description)
	};
}

export const sortKey = (m: Moment) => `${m.date}T${m.time ?? '00:00'}`;

export function parseEvents(code: string, viewerTimeZone?: string): EventList | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(code);
	} catch {
		return null;
	}
	const root = rec(parsed);
	const list = Array.isArray(parsed) ? parsed : (root?.events ?? root?.items);
	if (!Array.isArray(list)) return null;
	const tzIn = str(root?.timeZone);
	const venueZone = tzIn && isValidZone(tzIn) ? tzIn : null;
	const timeZone = venueZone ?? viewerTimeZone;

	const all = list
		.map((e, i) => parseEvent(e, i, timeZone))
		.filter((e): e is EventItem => e !== null)
		.sort((a, b) => sortKey(a.start).localeCompare(sortKey(b.start)));
	if (all.length === 0) return null;
	const events = all.slice(0, MAX_EVENTS);

	const months: EventMonth[] = [];
	for (const event of events) {
		const key = event.start.date.slice(0, 7);
		if (months.at(-1)?.key !== key) months.push({ key, events: [] });
		months.at(-1)!.events.push(event);
	}
	return { title: str(root?.title), events, months, total: all.length, timeZone: venueZone };
}
