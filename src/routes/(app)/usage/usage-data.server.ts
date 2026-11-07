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
	proxyRequestProviderUsage,
	proxyRequestStats
} from '$lib/server/db/repo/proxy-requests.js';
import { listProviders } from '$lib/server/db/repo/providers.js';
import { dayInZone } from '$lib/server/t3/usage.js';
import {
	parseUsagePeriod,
	periodDays,
	type PaygProvider,
	type PaygUsage,
	type SubscriptionProvider,
	type SubscriptionUsage,
	type UsageAccount,
	type UsagePeriod
} from '$lib/components/app/usage/usage.js';

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
	period: UsagePeriod;
	days: string[];
	/** Local midnight (config.TZ) that starts the first day. */
	startMs: number;
	now: number;
}

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

/** `period` as whole local days, today included. */
export function windowForPeriod(period: UsagePeriod, now = Date.now()): UsageWindow {
	const startMs = startOfLocalDay(now - (periodDays(period) - 1) * DAY_MS);
	return { period, days: localDays(startMs, now), startMs, now };
}

/** The period from `?period=` as whole local days, today included. */
export function usageWindow(url: URL, now = Date.now()): UsageWindow {
	return windowForPeriod(parseUsagePeriod(url.searchParams.get('period')), now);
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

/** Usage mirrored from the user's coding environments (fixed-cost subscriptions). */
export function loadSubscriptionUsage(
	db: Db,
	userId: string,
	window: UsageWindow
): SubscriptionUsage {
	const environments = listCodingEnvironments(db, userId).map(toPublic);
	const envNames = new Map(environments.map((e) => [e.id, e.name]));

	// ── limit windows, grouped per provider account ──
	const accounts = new Map<string, UsageAccount>();
	for (const w of listUsageLimits(db, userId)) {
		const key = `${w.environmentId}:${w.accountId}`;
		let account = accounts.get(key);
		if (!account) {
			account = {
				key,
				environmentId: w.environmentId,
				environmentName: envNames.get(w.environmentId) ?? '',
				provider: w.provider,
				accountLabel: w.accountLabel,
				accountEmail: w.accountEmail,
				accountPlan: w.accountPlan,
				checkedAt: w.checkedAt,
				windows: []
			};
			accounts.set(key, account);
		}
		account.checkedAt = Math.max(account.checkedAt, w.checkedAt);
		account.windows.push(w);
	}

	// ── daily token/cost buckets ──
	const providers = new Map<string, SubscriptionProvider>();
	const byDay = new Map<string, Map<string, { tokens: number; costUsd: number }>>();
	for (const r of listUsageDaily(db, userId, window.days[0])) {
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

	const dailyRows = window.days.map((day) => {
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
		accounts: [...accounts.values()],
		providers: sorted,
		dailyRows,
		totalValueUsd: sorted.reduce((sum, p) => sum + p.costUsd, 0),
		totalTokens: sorted.reduce((sum, p) => sum + p.tokens, 0),
		totalSessions: sorted.reduce((sum, p) => sum + p.sessions, 0),
		anyUnpriced: sorted.some((p) => !p.priced)
	};
}

/** Actual spend through Chatty's configured providers (billed per token). */
export function loadPaygUsage(db: Db, userId: string, window: UsageWindow): PaygUsage {
	const providerSlots = new Map(listProviders(db).map((p, i) => [p.id, i]));
	const rows = proxyRequestProviderUsage(
		db,
		{ userId, from: window.startMs },
		utcOffsetMinutes(window.now)
	);
	const providers = new Map<string, PaygProvider>();
	const byDay = new Map<string, Map<string, number>>();
	for (const r of rows) {
		if (r.day < window.days[0]) continue;
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
				requests: 0,
				models: []
			};
			providers.set(key, p);
		}
		p.costUsd += r.costUsd;
		p.inputTokens += r.inputTokens;
		p.outputTokens += r.outputTokens;
		p.requests += r.requests;
		let m = p.models.find((x) => x.model === r.model);
		if (!m) {
			m = { model: r.model, costUsd: 0, tokens: 0, requests: 0 };
			p.models.push(m);
		}
		m.costUsd += r.costUsd;
		m.tokens += r.inputTokens + r.outputTokens;
		m.requests += r.requests;

		let dayMap = byDay.get(r.day);
		if (!dayMap) byDay.set(r.day, (dayMap = new Map()));
		dayMap.set(key, (dayMap.get(key) ?? 0) + r.costUsd);
	}
	const sorted = [...providers.values()].sort(
		(a, b) => b.costUsd - a.costUsd || b.requests - a.requests
	);
	for (const p of sorted) p.models.sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
	const dailyRows = window.days.map((day) => {
		const dayMap = byDay.get(day);
		const cost: Record<string, number> = {};
		for (const p of sorted) cost[p.key] = dayMap?.get(p.key) ?? 0;
		return { day, cost };
	});

	const periodMs = window.days.length * DAY_MS;
	const previous = proxyRequestStats(db, {
		userId,
		from: window.startMs - periodMs,
		to: window.startMs - 1
	});

	return {
		providers: sorted,
		dailyRows,
		totalCostUsd: sorted.reduce((sum, p) => sum + p.costUsd, 0),
		totalTokens: sorted.reduce((sum, p) => sum + p.inputTokens + p.outputTokens, 0),
		totalRequests: sorted.reduce((sum, p) => sum + p.requests, 0),
		previousCostUsd: previous.costUsd,
		previousRequests: previous.total
	};
}
