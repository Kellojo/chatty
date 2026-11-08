// Aggregation shared by the Usage Overview and Subscriptions pages.

import { config } from '$lib/server/config.js';
import type { Db } from '$lib/server/db/index.js';
import {
	listCodingEnvironments,
	listUsageDaily,
	listUsageLimits,
	toPublic
} from '$lib/server/db/repo/coding-environments.js';
import {
	proxyRequestFirstStartedAt,
	proxyRequestProviderUsage,
	proxyRequestStats
} from '$lib/server/db/repo/proxy-requests.js';
import { listProviders } from '$lib/server/db/repo/providers.js';
import { dayInZone } from '$lib/server/t3/usage.js';
import {
	formatDayShort,
	groupUsageAccounts,
	isUsagePeriod,
	parseUsagePeriod,
	periodDays,
	selectedRange,
	type UsageRange,
	type SubscriptionProvider,
	type SubscriptionUsage,
	type UsagePeriod
} from '$lib/components/app/usage/usage.js';
import type { PaygProviderWithCache, PaygUsageWithCache } from '$lib/usage-cache-types.js';

const DAY_MS = 86_400_000;

/** Minutes `timeZone` is ahead of UTC at `at` (DST-aware for that instant). */
export function utcOffsetMinutes(at: number, timeZone = config.TZ): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric'
	}).formatToParts(new Date(at));
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
	const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
	return Math.round((asUtc - Math.floor(at / 60_000) * 60_000) / 60_000);
}

export interface UsageWindow {
	range: UsageRange;
	/** The shared 7d/30d/90d preset (what tab links fall back to). */
	period: UsagePeriod;
	/** "last 30 days", "last 24 hours", "all time", "Oct 1 – Oct 12". */
	label: string;
	/** Request bounds (inclusive); undefined is open-ended. */
	fromMs?: number;
	toMs?: number;
	/** Local (config.TZ) days the daily charts show. */
	days: string[];
	/** The range is longer than the chart, which shows its most recent days. */
	chartCapped: boolean;
	/** Custom range inputs as given (YYYY-MM-DD), for the date fields. */
	customFrom: string;
	customTo: string;
	now: number;
}

/** Longest span a daily chart draws. */
const MAX_CHART_DAYS = 365;

/** Local midnight (config.TZ) of the day containing `at`. */
export function startOfLocalDay(at: number): number {
	const offsetMs = utcOffsetMinutes(at) * 60_000;
	return at - ((((at + offsetMs) % DAY_MS) + DAY_MS) % DAY_MS);
}

/** Local (config.TZ) day keys from `fromMs` to `toMs`, both included. */
export function localDays(fromMs: number, toMs: number): string[] {
	const days: string[] = [];
	for (let ms = fromMs; ms <= toMs + DAY_MS - 1; ms += DAY_MS / 2) {
		const day = dayInZone(Math.min(ms, toMs), config.TZ);
		if (days.at(-1) !== day) days.push(day);
	}
	return days;
}

/** Local midnight that starts a YYYY-MM-DD day, or undefined for a malformed value. */
function startOfDayKey(day: string): number | undefined {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!m) return undefined;
	// Noon UTC always falls inside that local day, whatever the offset.
	return startOfLocalDay(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}

function chartDays(fromMs: number, toMs: number): { days: string[]; capped: boolean } {
	const start = Math.max(fromMs, startOfLocalDay(toMs - (MAX_CHART_DAYS - 1) * DAY_MS));
	return { days: localDays(startOfLocalDay(start), toMs), capped: start > fromMs };
}

/** `period` as whole local days, today included. */
export function windowForPeriod(period: UsagePeriod, now = Date.now()): UsageWindow {
	const fromMs = startOfLocalDay(now - (periodDays(period) - 1) * DAY_MS);
	return {
		range: period,
		period,
		label: `last ${periodDays(period)} days`,
		fromMs,
		days: localDays(fromMs, now),
		chartCapped: false,
		customFrom: '',
		customTo: '',
		now
	};
}

/**
 * The selected time range (`period`, or `range` = 24h / all / custom with `from`/`to`).
 * `firstMs` gives the earliest data point, used to start "all time" and open custom ranges.
 */
export function usageWindow(
	url: URL,
	now = Date.now(),
	firstMs: () => number | null = () => null
): UsageWindow {
	const params = url.searchParams;
	const range = selectedRange(params);
	const period = parseUsagePeriod(params.get('period'));
	if (isUsagePeriod(range)) return { ...windowForPeriod(range, now), period };

	const base = { range, period, customFrom: '', customTo: '', now };
	if (range === '24h') {
		const fromMs = now - DAY_MS;
		return {
			...base,
			label: 'last 24 hours',
			fromMs,
			days: localDays(startOfLocalDay(fromMs), now),
			chartCapped: false
		};
	}
	if (range === 'all') {
		const first = firstMs() ?? now;
		const { days, capped } = chartDays(startOfLocalDay(first), now);
		return { ...base, label: 'all time', days, chartCapped: capped };
	}
	// Custom dates (local days, both included); a missing end means today.
	const customFrom = params.get('from') ?? '';
	const customTo = params.get('to') ?? '';
	const fromMs = startOfDayKey(customFrom);
	const toStart = startOfDayKey(customTo);
	const toMs = toStart === undefined ? undefined : Math.min(now, toStart + DAY_MS - 1);
	const axisFrom = fromMs ?? startOfLocalDay(firstMs() ?? now);
	const { days, capped } = chartDays(axisFrom, Math.max(axisFrom, toMs ?? now));
	const fromLabel = customFrom && fromMs !== undefined ? formatDayShort(customFrom) : 'start';
	const toLabel = customTo && toStart !== undefined ? formatDayShort(customTo) : 'today';
	return {
		...base,
		label: `${fromLabel} – ${toLabel}`,
		fromMs,
		toMs,
		days,
		chartCapped: capped,
		customFrom,
		customTo
	};
}

/** The earliest pay-as-you-go request of `userId`, for "all time" axes. */
export function firstPaygRequest(db: Db, userId: string): () => number | null {
	return () => proxyRequestFirstStartedAt(db, { userId });
}

function totalTokens(r: {
	inputTokens: number;
	cachedInputTokens: number;
	cacheCreationTokens: number;
	outputTokens: number;
}): number {
	// Reasoning tokens are already included in output.
	return r.inputTokens + r.cachedInputTokens + r.cacheCreationTokens + r.outputTokens;
}

/** Day keys from `fromDay` to `toDay`, both included. */
function localDaysFromKey(fromDay: string, toDay: string): string[] {
	const fromMs = startOfDayKey(fromDay);
	const toMs = startOfDayKey(toDay);
	if (fromMs === undefined || toMs === undefined) return [toDay];
	return chartDays(fromMs, toMs + DAY_MS - 1).days;
}

/** Usage mirrored from the user's coding environments (fixed-cost subscriptions). */
export function loadSubscriptionUsage(
	db: Db,
	userId: string,
	window: UsageWindow
): SubscriptionUsage {
	const environments = listCodingEnvironments(db, userId).map(toPublic);
	const envNames = new Map(environments.map((e) => [e.id, e.name]));

	// ── limit windows, grouped per provider account ──
	const accounts = groupUsageAccounts(listUsageLimits(db, userId), envNames);

	// ── daily token/cost buckets ──
	// Subscription usage only exists as whole days: 24h shows today's bucket, "all time" starts
	// at the first synced day, and custom ranges are clamped to the synced history.
	const today = dayInZone(window.now, config.TZ);
	const fetched = listUsageDaily(
		db,
		userId,
		window.range === 'all' || window.range === 'custom' ? '0000-00-00' : window.days[0]
	);
	const firstSynced = fetched[0]?.day ?? null;
	let days = window.days;
	let note: string | null = null;
	if (window.range === '24h') {
		days = [today];
		note = "Subscription usage is synced per day, so this shows today's total.";
	} else if (window.range === 'all') {
		days = firstSynced ? localDaysFromKey(firstSynced, today) : [];
	} else if (window.range === 'custom' && firstSynced && days[0] < firstSynced) {
		days = days.filter((d) => d >= firstSynced);
		if (window.customFrom)
			note = `Subscription history is only synced from ${formatDayShort(firstSynced)}.`;
	}
	const inRange = new Set(days);
	const providers = new Map<string, SubscriptionProvider>();
	const byDay = new Map<string, Map<string, { tokens: number; costUsd: number }>>();
	for (const r of fetched) {
		if (!inRange.has(r.day)) continue;
		const tokens = totalTokens(r);
		let p = providers.get(r.provider);
		if (!p) {
			p = {
				provider: r.provider,
				tokens: 0,
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				costUsd: 0,
				sessions: 0,
				priced: true,
				models: []
			};
			providers.set(r.provider, p);
		}
		p.tokens += tokens;
		p.inputTokens += r.inputTokens + r.cacheCreationTokens;
		p.cachedInputTokens += r.cachedInputTokens;
		p.outputTokens += r.outputTokens;
		p.costUsd += r.costUsd;
		p.sessions += r.sessions;
		p.priced &&= r.priced;
		let m = p.models.find((x) => x.model === r.model);
		if (!m) {
			m = { model: r.model, tokens: 0, costUsd: 0, sessions: 0, priced: true };
			p.models.push(m);
		}
		m.tokens += tokens;
		m.costUsd += r.costUsd;
		m.sessions += r.sessions;
		m.priced &&= r.priced;

		let dayMap = byDay.get(r.day);
		if (!dayMap) byDay.set(r.day, (dayMap = new Map()));
		const cell = dayMap.get(r.provider) ?? { tokens: 0, costUsd: 0 };
		cell.tokens += tokens;
		cell.costUsd += r.costUsd;
		dayMap.set(r.provider, cell);
	}

	const sorted = [...providers.values()].sort(
		(a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens
	);
	for (const p of sorted) p.models.sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);

	const dailyRows = days.map((day) => {
		const dayMap = byDay.get(day);
		const row: SubscriptionUsage['dailyRows'][number] = { day, cost: {}, tokens: {} };
		for (const p of sorted) {
			const cell = dayMap?.get(p.provider);
			row.cost[p.provider] = cell?.costUsd ?? 0;
			row.tokens[p.provider] = cell?.tokens ?? 0;
		}
		return row;
	});

	return {
		environments,
		accounts,
		providers: sorted,
		dailyRows,
		totalValueUsd: sorted.reduce((sum, p) => sum + p.costUsd, 0),
		totalTokens: sorted.reduce((sum, p) => sum + p.tokens, 0),
		totalSessions: sorted.reduce((sum, p) => sum + p.sessions, 0),
		anyUnpriced: sorted.some((p) => !p.priced),
		note
	};
}

/** Actual spend through Chatty's configured providers (billed per token). */
export function loadPaygUsage(db: Db, userId: string, window: UsageWindow): PaygUsageWithCache {
	const providerSlots = new Map(listProviders(db).map((p, i) => [p.id, i]));
	const rows = proxyRequestProviderUsage(
		db,
		{ userId, from: window.fromMs, to: window.toMs },
		utcOffsetMinutes(window.now)
	);
	const providers = new Map<string, PaygProviderWithCache>();
	const byDay = new Map<string, Map<string, { costUsd: number; requests: number }>>();
	for (const r of rows) {
		const key = r.providerId ?? 'unknown';
		let p = providers.get(key);
		if (!p) {
			p = {
				key,
				providerId: r.providerId,
				name: r.providerName ?? r.providerId ?? 'Unknown',
				colorSlot: r.providerId ? (providerSlots.get(r.providerId) ?? null) : null,
				costUsd: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				requests: 0,
				pricedRequests: 0,
				models: []
			};
			providers.set(key, p);
		}
		p.costUsd += r.costUsd;
		p.inputTokens += r.inputTokens;
		p.outputTokens += r.outputTokens;
		p.cacheReadTokens += r.cacheReadTokens;
		p.cacheWriteTokens += r.cacheWriteTokens;
		p.requests += r.requests;
		p.pricedRequests += r.pricedRequests;
		let m = p.models.find((x) => x.model === r.model);
		if (!m) {
			m = {
				model: r.model,
				costUsd: 0,
				tokens: 0,
				requests: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0
			};
			p.models.push(m);
		}
		m.costUsd += r.costUsd;
		m.tokens += r.inputTokens + r.outputTokens;
		m.cacheReadTokens += r.cacheReadTokens;
		m.cacheWriteTokens += r.cacheWriteTokens;
		m.requests += r.requests;

		let dayMap = byDay.get(r.day);
		if (!dayMap) byDay.set(r.day, (dayMap = new Map()));
		const cell = dayMap.get(key) ?? { costUsd: 0, requests: 0 };
		cell.costUsd += r.costUsd;
		cell.requests += r.requests;
		dayMap.set(key, cell);
	}
	const sorted = [...providers.values()].sort(
		(a, b) => b.costUsd - a.costUsd || b.requests - a.requests
	);
	for (const p of sorted) p.models.sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
	const dailyRows = window.days.map((day) => {
		const dayMap = byDay.get(day);
		const cost: Record<string, number> = {};
		const requests: Record<string, number> = {};
		for (const p of sorted) {
			cost[p.key] = dayMap?.get(p.key)?.costUsd ?? 0;
			requests[p.key] = dayMap?.get(p.key)?.requests ?? 0;
		}
		return { day, cost, requests };
	});

	// The equally long range just before this one (none for open-ended ranges).
	let previous: PaygUsageWithCache['previous'] = null;
	if (window.fromMs !== undefined) {
		const span = (window.toMs ?? window.now) - window.fromMs;
		const stats = proxyRequestStats(db, {
			userId,
			from: window.fromMs - span - 1,
			to: window.fromMs - 1
		});
		previous = {
			costUsd: stats.costUsd,
			requests: stats.total,
			pricedRequests: stats.pricedRequests
		};
	}

	return {
		providers: sorted,
		dailyRows,
		totalCostUsd: sorted.reduce((sum, p) => sum + p.costUsd, 0),
		totalTokens: sorted.reduce((sum, p) => sum + p.inputTokens + p.outputTokens, 0),
		totalCacheReadTokens: sorted.reduce((sum, p) => sum + p.cacheReadTokens, 0),
		totalCacheWriteTokens: sorted.reduce((sum, p) => sum + p.cacheWriteTokens, 0),
		totalRequests: sorted.reduce((sum, p) => sum + p.requests, 0),
		pricedRequests: sorted.reduce((sum, p) => sum + p.pricedRequests, 0),
		previous,
		chartCapped: window.chartCapped
	};
}
