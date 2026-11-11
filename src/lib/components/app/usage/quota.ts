// Quota of one provider across its accounts: what was left over the selected range, a
// projection that keeps today's burn rate through future resets, and every reset coming
// up. Client-safe and pure, so it re-derives as the clock ticks.

import type { CodingUsageLimitWindow } from '$lib/coding-environments.js';
import {
	buildBurndown,
	windowStart,
	type BurndownPoint,
	type BurndownRange,
	type LimitHistorySample
} from './burndown.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** One account's main limit window and its synced readings. */
export interface QuotaAccount {
	key: string;
	label: string;
	window: CodingUsageLimitWindow;
	history: LimitHistorySample[];
}

/** A reset the projection passes through, with what it gives back. */
export interface QuotaReset {
	at: number;
	/** Percentage points restored (the window always refills to 100%). */
	gain: number;
}

export interface QuotaPool {
	/** 100% per account. */
	capacity: number;
	/** Percent left now, summed over the accounts. */
	remaining: number;
	/** What was left over the range (solid). */
	recorded: BurndownPoint[];
	/** Recorded points before this are inferred (a window start with no reading yet). */
	assumedUntil: number | null;
	/** Where the current burn rate leads, through resets (dashed); empty for a past range. */
	projected: BurndownPoint[];
	/** Resets inside the projection, with their gain (summed when several coincide). */
	resets: QuotaReset[];
	/** Combined burn rate in percentage points per hour; null with no pace yet. */
	burnPerHour: number | null;
	/** When the pool runs dry at this rate, within the projection. */
	emptyAt: number | null;
	/** When the first account runs dry, within the projection. */
	firstEmptyAt: number | null;
	/** Accounts that run dry before their own next reset at this rate, soonest first. */
	emptyEarly: { key: string; label: string; at: number; resetAt: number | null }[];
	/** Latest reading: where recorded ends and projected starts. */
	asOf: number;
}

/** Length of one cycle of a window (reset to reset); null if unknown. */
export function cycleLength(w: CodingUsageLimitWindow): number | null {
	if (w.resetsAt === null) return null;
	const start = windowStart(w.windowKind, w.resetsAt);
	return start === null ? null : w.resetsAt - start;
}

/**
 * One account's future from its latest reading until `until`: burning at `perHour`,
 * flat at 0% once empty, and back to 100% at each reset.
 */
export function simulateAccount(
	w: CodingUsageLimitWindow,
	perHour: number,
	until: number
): { points: BurndownPoint[]; resets: QuotaReset[]; emptyAt: number | null } {
	const perMs = perHour / HOUR;
	const len = cycleLength(w);
	let t = w.checkedAt;
	let left = Math.min(100, Math.max(0, 100 - w.usedPercent));
	let reset = w.resetsAt;
	// A reading taken before a reset that has since passed is stale: it refilled.
	while (reset !== null && reset <= t) {
		left = 100;
		reset = len ? reset + len : null;
	}
	const points: BurndownPoint[] = [{ at: t, remaining: left }];
	const resets: QuotaReset[] = [];
	let emptyAt: number | null = null;
	while (t < until) {
		const next = reset !== null && reset < until ? reset : until;
		const dryAt = perMs > 0 ? t + left / perMs : Infinity;
		if (dryAt < next) {
			points.push({ at: Math.round(dryAt), remaining: 0 });
			emptyAt ??= Math.round(dryAt);
			left = 0;
		} else {
			left -= perMs * (next - t);
		}
		points.push({ at: next, remaining: left });
		t = next;
		if (reset !== null && next === reset) {
			resets.push({ at: reset, gain: 100 - left });
			left = 100;
			points.push({ at: reset, remaining: left });
			reset = len ? reset + len : null;
		}
	}
	return { points, resets, emptyAt };
}

/** Value of a stepped line at `at`: before or after a jump there; edges hold. */
function valueAt(points: BurndownPoint[], at: number, side: 'before' | 'after'): number {
	if (at < points[0].at) return points[0].remaining;
	if (at > points.at(-1)!.at) return points.at(-1)!.remaining;
	const i = points.findIndex((p) => p.at >= at);
	if (points[i].at === at) {
		if (side === 'before') return points[i].remaining;
		let j = i;
		while (points[j + 1]?.at === at) j++;
		return points[j].remaining;
	}
	const a = points[i - 1];
	const c = points[i];
	return a.remaining + ((c.remaining - a.remaining) * (at - a.at)) / (c.at - a.at);
}

/** The sum of several stepped lines over `[from, to]`, jumps kept. */
export function sumLines(lines: BurndownPoint[][], from: number, to: number): BurndownPoint[] {
	const live = lines.filter((l) => l.length > 0);
	if (live.length === 0 || to < from) return [];
	const times = [
		...new Set(
			[from, to, ...live.flatMap((l) => l.map((p) => p.at))].filter((t) => t >= from && t <= to)
		)
	].sort((a, b) => a - b);
	const out: BurndownPoint[] = [];
	for (const at of times) {
		const before = live.reduce((sum, l) => sum + valueAt(l, at, 'before'), 0);
		const after = live.reduce((sum, l) => sum + valueAt(l, at, 'after'), 0);
		out.push({ at, remaining: before });
		if (after !== before) out.push({ at, remaining: after });
	}
	return out;
}

/** How far ahead to project: one cycle of the main window (a day to a month). */
export function projectionHorizon(accounts: QuotaAccount[]): number {
	const len = Math.max(0, ...accounts.map((a) => cycleLength(a.window) ?? 7 * DAY));
	return Math.min(31 * DAY, Math.max(DAY, len));
}

export function buildQuotaPool(
	accounts: QuotaAccount[],
	now: number,
	range: BurndownRange = {}
): QuotaPool {
	const asOf = Math.max(...accounts.map((a) => a.window.checkedAt));
	const burndowns = accounts.map((a) => buildBurndown(a.window, a.history, now, range));
	const remaining = burndowns.reduce((sum, b) => sum + b.remainingNow, 0);

	const lines = burndowns.map((b) => b.points);
	const from = Math.min(...lines.filter((l) => l.length).map((l) => l[0].at));
	const recorded = Number.isFinite(from)
		? sumLines(lines, from, Math.min(asOf, range.to ?? Infinity))
		: [];

	// The range reaches the latest reading, so there is a future to project.
	const live = (range.to ?? Infinity) >= asOf;
	const paces = burndowns.map((b) => b.pacePerHour);
	const burnPerHour = paces.some((p) => p !== null)
		? paces.reduce<number>((sum, p) => sum + (p ?? 0), 0)
		: null;

	let projected: BurndownPoint[] = [];
	let resets: QuotaReset[] = [];
	let firstEmptyAt: number | null = null;
	let emptyEarly: QuotaPool['emptyEarly'] = [];
	if (live) {
		const until = asOf + projectionHorizon(accounts);
		const sims = accounts.map((a, i) => simulateAccount(a.window, paces[i] ?? 0, until));
		projected = sumLines(
			sims.map((s) => s.points),
			asOf,
			until
		);
		const gains = new Map<number, number>();
		for (const r of sims.flatMap((s) => s.resets)) gains.set(r.at, (gains.get(r.at) ?? 0) + r.gain);
		resets = [...gains].map(([at, gain]) => ({ at, gain })).sort((a, b) => a.at - b.at);
		const empties = sims.map((s) => s.emptyAt).filter((t): t is number => t !== null);
		firstEmptyAt = empties.length ? Math.min(...empties) : null;
		emptyEarly = sims
			.flatMap((s, i) => {
				const firstReset = s.resets.find((r) => r.at > now)?.at ?? Infinity;
				return s.emptyAt !== null && s.emptyAt > now && s.emptyAt < firstReset
					? [
							{
								key: accounts[i].key,
								label: accounts[i].label,
								at: s.emptyAt,
								resetAt: Number.isFinite(firstReset) ? firstReset : null
							}
						]
					: [];
			})
			.sort((a, b) => a.at - b.at);
	}
	const emptyAt = projected.find((p) => p.remaining <= 0.05)?.at ?? null;

	return {
		capacity: 100 * accounts.length,
		remaining,
		recorded,
		assumedUntil: Math.max(0, ...burndowns.map((b) => b.assumedUntil ?? 0)) || null,
		projected,
		resets,
		burnPerHour,
		emptyAt,
		firstEmptyAt,
		emptyEarly,
		asOf
	};
}

/** A reset coming up for any limit window, with what it is set to give back. */
export interface UpcomingReset {
	key: string;
	at: number;
	windowLabel: string;
	accountLabel: string;
	/** Percent left now. */
	left: number;
	/** Percentage points it restores: what is used by then at the current pace. */
	gain: number;
}

/** Every window's next reset, soonest first (windows already past their reset are left out). */
export function upcomingResets(
	windows: { accountLabel: string; window: CodingUsageLimitWindow }[],
	now: number
): UpcomingReset[] {
	return windows
		.filter(({ window: w }) => w.resetsAt !== null && w.resetsAt > now)
		.map(({ accountLabel, window: w }) => {
			const b = buildBurndown(w, [], now);
			const leftAtReset = b.projection?.remainingAtReset ?? b.remainingNow;
			return {
				key: `${w.environmentId}:${w.accountId}:${w.windowId}`,
				at: w.resetsAt!,
				windowLabel: w.windowLabel,
				accountLabel,
				left: Math.round(b.remainingNow),
				gain: Math.round(100 - leftAtReset)
			};
		})
		.sort((a, b) => a.at - b.at);
}
