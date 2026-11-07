// Defensive parsers for the two T3 Code payloads Chatty mirrors:
// - `server.getConfig` → `providers[].usageLimits` (subscription limit windows)
// - `server.getUsageSummary` → per day/provider/model token + cost buckets
// Unknown fields and variants are ignored; malformed entries are skipped.

import type {
	CodingUsageDailyRow,
	CodingUsageLimitWindow,
	UsageWindowKind
} from '$lib/coding-environments.js';
import { providerLabel } from '$lib/coding-environments.js';

type LimitRow = Omit<CodingUsageLimitWindow, 'environmentId'>;
type DailyRow = Omit<CodingUsageDailyRow, 'environmentId'>;

const WINDOW_KINDS = new Set<UsageWindowKind>(['session', 'weekly', 'monthly', 'other']);
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function obj(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function int(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function time(value: unknown): number | null {
	const s = str(value);
	if (!s) return null;
	const ms = Date.parse(s);
	return Number.isNaN(ms) ? null : ms;
}

/** Extracts usage-limit windows from a `ServerConfig` (or `{ providers }`) payload. */
export function parseUsageLimits(config: unknown, now = Date.now()): LimitRow[] {
	const providers = obj(config)?.providers;
	if (!Array.isArray(providers)) return [];
	const rows: LimitRow[] = [];
	const seen = new Set<string>();
	for (const entry of providers) {
		const provider = obj(entry);
		const limits = obj(provider?.usageLimits);
		if (!provider || !limits || !Array.isArray(limits.windows)) continue;
		const accountId = str(provider.instanceId);
		const driver = str(provider.driver);
		if (!accountId || !driver) continue;
		const auth = obj(provider.auth);
		const checkedAt = time(limits.checkedAt) ?? now;
		for (const w of limits.windows) {
			const win = obj(w);
			const windowId = str(win?.id);
			const usedPercent = win?.usedPercent;
			if (!win || !windowId || typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) {
				continue;
			}
			const key = `${accountId}\u0000${windowId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const kind = str(win.kind) as UsageWindowKind | null;
			rows.push({
				accountId,
				provider: driver,
				accountLabel: str(provider.displayName) ?? providerLabel(driver),
				accountEmail: str(auth?.email),
				accountPlan: str(auth?.label),
				windowId,
				windowKind: kind && WINDOW_KINDS.has(kind) ? kind : 'other',
				windowLabel: str(win.label) ?? windowId,
				usedPercent: Math.min(100, Math.max(0, usedPercent)),
				resetsAt: time(win.resetsAt),
				checkedAt
			});
		}
	}
	return rows;
}

export interface ParsedUsageSummary {
	sinceDay: string | null;
	untilDay: string | null;
	rows: DailyRow[];
}

/** Extracts day buckets from a `UsageSummary`. Hourly buckets are folded into their day. */
export function parseUsageSummary(summary: unknown): ParsedUsageSummary {
	const s = obj(summary);
	const sinceDay = str(s?.sinceDay);
	const untilDay = str(s?.untilDay);
	const rows: DailyRow[] = [];
	if (Array.isArray(s?.buckets)) {
		for (const b of s.buckets) {
			const bucket = obj(b);
			const day = str(bucket?.day);
			const provider = str(bucket?.provider);
			const model = str(bucket?.model);
			if (!bucket || !day || !DAY_PATTERN.test(day) || !provider || !model) continue;
			const totals = obj(bucket.totals) ?? {};
			const cost = bucket.costUsd;
			rows.push({
				day,
				provider,
				model,
				inputTokens: int(totals.uncachedInputTokens),
				cachedInputTokens: int(totals.cachedInputTokens),
				cacheCreationTokens: int(totals.cacheCreationTokens),
				outputTokens: int(totals.outputTokens),
				reasoningTokens: int(totals.reasoningTokens),
				costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : 0,
				priced: bucket.costSource !== 'unpriced' && int(bucket.unpricedRecords) === 0,
				sessions: int(bucket.sessions)
			});
		}
	}
	return {
		sinceDay: sinceDay && DAY_PATTERN.test(sinceDay) ? sinceDay : null,
		untilDay: untilDay && DAY_PATTERN.test(untilDay) ? untilDay : null,
		rows
	};
}

/** `YYYY-MM-DD` for `ms` in `timeZone`. */
export function dayInZone(ms: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(new Date(ms));
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	return `${get('year')}-${get('month')}-${get('day')}`;
}
