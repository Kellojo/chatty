// Client-safe types and helpers shared by the Usage pages (Overview, Requests,
// Subscriptions) and their server loads.

import type { CodingEnvironment, CodingUsageLimitWindow } from '$lib/coding-environments.js';

// ── period ───────────────────────────────────────────────────────────────

export const USAGE_PERIODS = ['7d', '30d', '90d'] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];
export const DEFAULT_USAGE_PERIOD: UsagePeriod = '30d';

export function isUsagePeriod(value: string | null | undefined): value is UsagePeriod {
	return (USAGE_PERIODS as readonly string[]).includes(value ?? '');
}

/** The `?period=` value, falling back to the default for missing/unknown values. */
export function parseUsagePeriod(value: string | null | undefined): UsagePeriod {
	return isUsagePeriod(value) ? value : DEFAULT_USAGE_PERIOD;
}

export function periodDays(period: UsagePeriod): number {
	return Number.parseInt(period, 10);
}

/** Query string carrying the period (empty for the default, so URLs stay clean). */
export function periodQuery(period: UsagePeriod, extra: Record<string, string> = {}): string {
	const params = new URLSearchParams();
	if (period !== DEFAULT_USAGE_PERIOD) params.set('period', period);
	for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
	const qs = params.toString();
	return qs ? `?${qs}` : '';
}

// ── colors ───────────────────────────────────────────────────────────────

// Color follows the entity, never its rank. Order validated for CVD separation
// against the app's chart tokens (blue / orange / purple / teal adjacent pairs).
const SUBSCRIPTION_COLORS: Record<string, string> = {
	codex: 'var(--chart-1)',
	claude: 'var(--chart-3)',
	claudeAgent: 'var(--chart-3)',
	opencode: 'var(--chart-5)',
	cursor: 'var(--chart-4)',
	grok: 'var(--chart-2)'
};
const SUBSCRIPTION_OTHER_COLOR = 'var(--chart-other)';

/** Color of a subscription (coding environment) provider such as `claude` or `codex`. */
export function subscriptionColor(provider: string): string {
	return SUBSCRIPTION_COLORS[provider] ?? SUBSCRIPTION_OTHER_COLOR;
}

// Pay-as-you-go providers (Chatty's own) are keyed by their position in settings, so a
// provider keeps its color regardless of spend.
const PAYG_PALETTE = [
	'var(--chart-1)',
	'var(--chart-2)',
	'var(--chart-3)',
	'var(--chart-4)',
	'var(--chart-5)'
];
const PAYG_UNKNOWN_COLOR = 'var(--muted-foreground)';

export function paygColor(slot: number | null): string {
	return slot === null ? PAYG_UNKNOWN_COLOR : PAYG_PALETTE[slot % PAYG_PALETTE.length];
}

/**
 * Fixed color per model: its position in `allModels` (every model the viewer has used) picks
 * the palette slot, so a model keeps its color across ranges and filters. Collisions among
 * the shown `models` move to the next free slot; `Other` is always the neutral color.
 */
export function modelColors(models: string[], allModels: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	const taken = new Set<number>();
	const ranked = models
		.filter((m) => m !== 'Other')
		.map((m) => ({ m, slot: Math.max(0, allModels.indexOf(m)) }))
		.sort((a, b) => a.slot - b.slot);
	for (const { m, slot } of ranked) {
		let i = slot % PAYG_PALETTE.length;
		for (let n = 0; n < PAYG_PALETTE.length && taken.has(i); n++) i = (i + 1) % PAYG_PALETTE.length;
		taken.add(i);
		out[m] = PAYG_PALETTE[i];
	}
	if (models.includes('Other')) out.Other = SUBSCRIPTION_OTHER_COLOR;
	return out;
}

// ── dates ────────────────────────────────────────────────────────────────

function dayDate(day: string): Date {
	return new Date(`${day.slice(0, 10)}T00:00:00Z`);
}

/** "Oct 12" for a YYYY-MM-DD day key. */
export function formatDayShort(day: string): string {
	return new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC'
	}).format(dayDate(day));
}

/** "Sun, Oct 12, 2026" for a YYYY-MM-DD day key. */
export function formatDayLong(day: string): string {
	return new Intl.DateTimeFormat(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC'
	}).format(dayDate(day));
}

// ── data shapes ──────────────────────────────────────────────────────────

export type BillingType = 'payg' | 'subscription';

export interface UsageAccount {
	key: string;
	environmentId: string;
	environmentName: string;
	provider: string;
	accountLabel: string;
	accountEmail: string | null;
	accountPlan: string | null;
	checkedAt: number;
	windows: CodingUsageLimitWindow[];
}

/** Subscription usage per provider, priced at API list prices (not billed). */
export interface SubscriptionProvider {
	provider: string;
	tokens: number;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	costUsd: number;
	sessions: number;
	priced: boolean;
	models: {
		model: string;
		tokens: number;
		costUsd: number;
		sessions: number;
		priced: boolean;
	}[];
}

/** Spend through Chatty's own configured providers (billed per token). */
export interface PaygProvider {
	/** Provider id, or `unknown` for requests that never reached a provider. */
	key: string;
	providerId: string | null;
	name: string;
	/** Stable palette slot from the provider's position in settings; null if no longer configured. */
	colorSlot: number | null;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	requests: number;
	models: { model: string; costUsd: number; tokens: number; requests: number }[];
}

export interface SubscriptionUsage {
	environments: CodingEnvironment[];
	accounts: UsageAccount[];
	providers: SubscriptionProvider[];
	/** One row per day; `cost`/`tokens` keyed by provider. */
	dailyRows: { day: string; cost: Record<string, number>; tokens: Record<string, number> }[];
	totalValueUsd: number;
	totalTokens: number;
	totalSessions: number;
	/** Some records had no known price, so values are a lower bound. */
	anyUnpriced: boolean;
}

export interface PaygUsage {
	providers: PaygProvider[];
	/** One row per day; `cost` keyed by provider key. */
	dailyRows: { day: string; cost: Record<string, number> }[];
	totalCostUsd: number;
	totalTokens: number;
	totalRequests: number;
	/** Actual spend over the equally long period before this one. */
	previousCostUsd: number;
	previousRequests: number;
}

// ── plan limits ──────────────────────────────────────────────────────────

export function resetLabel(resetsAt: number | null, now: number): string | null {
	if (!resetsAt) return null;
	const ms = resetsAt - now;
	if (ms <= 0) return 'resetting now';
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `resets in ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
	return `resets ${new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(resetsAt)}`;
}

/** The plan-limit window closest to its cap, across all accounts. */
export function mostUsedWindow(
	accounts: UsageAccount[]
): { account: UsageAccount; window: CodingUsageLimitWindow } | null {
	let best: { account: UsageAccount; window: CodingUsageLimitWindow } | null = null;
	for (const account of accounts)
		for (const window of account.windows)
			if (!best || window.usedPercent > best.window.usedPercent) best = { account, window };
	return best;
}

// ── environments ─────────────────────────────────────────────────────────

/** Syncs one environment now; null when the request itself failed. */
export async function syncEnvironment(id: string): Promise<CodingEnvironment | null> {
	try {
		const res = await fetch(`/api/coding-environments/${id}/sync`, { method: 'POST' });
		if (!res.ok) return null;
		return ((await res.json()) as { environment: CodingEnvironment }).environment;
	} catch {
		return null;
	}
}
