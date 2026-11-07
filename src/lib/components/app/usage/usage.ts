// Client-safe types and helpers shared by the Usage pages (Overview, Requests,
// Subscriptions) and their server loads.

import type { CodingEnvironment, CodingUsageLimitWindow } from '$lib/coding-environments.js';
import { formatCost, formatSpend } from '$lib/formats.js';

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

/**
 * Every time range the Usage section offers. 7d/30d/90d are the shared `period`; the rest
 * live in `range` (custom dates also in `from`/`to`). Every tab supports all of them.
 */
export const USAGE_RANGES = ['24h', '7d', '30d', '90d', 'all', 'custom'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export function isUsageRange(value: string | null | undefined): value is UsageRange {
	return (USAGE_RANGES as readonly string[]).includes(value ?? '');
}

/** The URL params that carry the time range, so links between tabs keep it. */
export const RANGE_PARAMS = ['period', 'range', 'from', 'to'] as const;

/** The selected range from URL params: an explicit `range`, bare `from`/`to`, else the period. */
export function selectedRange(params: URLSearchParams): UsageRange {
	const range = params.get('range');
	if (isUsageRange(range)) return range;
	if (params.has('from') || params.has('to')) return 'custom';
	return parseUsagePeriod(params.get('period'));
}

/** Query string carrying the range params of `params` (plus `extra`). */
export function rangeQuery(
	params: URLSearchParams | Record<string, string>,
	extra: Record<string, string> = {}
): string {
	const get = (key: string) =>
		params instanceof URLSearchParams ? params.get(key) : (params[key] ?? null);
	const out = new URLSearchParams();
	for (const key of RANGE_PARAMS) {
		const value = get(key);
		if (value) out.set(key, value);
	}
	for (const [key, value] of Object.entries(extra)) if (value) out.set(key, value);
	const qs = out.toString();
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

/** FNV-1a: a small, stable string hash. */
function hashString(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Fixed color per model, independent of what is currently shown or filtered.
 *
 * Each model's preferred palette slot comes from a hash of its name. Collisions are resolved
 * once over `allModels` (every model the viewer can see, regardless of filters) in hash order,
 * so filtering, the time range or the Everyone/Me scope never repaints a model. A brand-new
 * model can shift models that hash into the same slot, but most keep their color. Once all
 * slots are used they are reused (the palette only has five colors). `Other` is always the
 * neutral color.
 */
export function modelColors(models: string[], allModels: string[]): Record<string, string> {
	const size = PAYG_PALETTE.length;
	const universe = [...new Set([...allModels, ...models])].filter((m) => m !== 'Other');
	const ordered = universe
		.map((name) => ({ name, hash: hashString(name) }))
		.sort((a, b) => a.hash - b.hash || a.name.localeCompare(b.name));
	const slotOf = new Map<string, number>();
	let taken = new Set<number>();
	for (const { name, hash } of ordered) {
		if (taken.size === size) taken = new Set();
		let slot = hash % size;
		while (taken.has(slot)) slot = (slot + 1) % size;
		taken.add(slot);
		slotOf.set(name, slot);
	}
	const out: Record<string, string> = {};
	for (const m of models) {
		out[m] = m === 'Other' ? SUBSCRIPTION_OTHER_COLOR : PAYG_PALETTE[slotOf.get(m)!];
	}
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
	/** Requests that reported a cost; 0 means none did, so the cost is unknown, not free. */
	pricedRequests: number;
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
	/** Why the subscription days differ from the selected range (daily buckets), if they do. */
	note: string | null;
}

export interface PaygUsage {
	providers: PaygProvider[];
	/** One row per day; `cost` and `requests` keyed by provider key. */
	dailyRows: { day: string; cost: Record<string, number>; requests: Record<string, number> }[];
	totalCostUsd: number;
	totalTokens: number;
	totalRequests: number;
	pricedRequests: number;
	/** The equally long range before this one; null for "all time". */
	previous: { costUsd: number; requests: number; pricedRequests: number } | null;
	/** The chart shows only the most recent days of a longer range. */
	chartCapped: boolean;
}

/**
 * Billed pay-as-you-go cost, the same way everywhere (Overview, request log, detail): a real
 * amount when the request(s) reported a cost, "—" when none did (no known price, which is
 * not the same as free).
 */
export function formatBilled(
	costUsd: number | null,
	{ pricedRequests = 1, precise = false }: { pricedRequests?: number; precise?: boolean } = {}
): string {
	if (costUsd === null || pricedRequests === 0) return '—';
	// A single request keeps sub-cent precision; totals round to cents.
	return precise ? formatCost(costUsd) : formatSpend(costUsd);
}

/** Explains a "—" billed value (tooltips and notes); never wrapped in parentheses. */
export const NO_COST_REPORTED = 'No cost reported · no known price for this model';

/**
 * `formatBilled` split into the value and an optional note, so callers render the note
 * themselves (muted, as a tooltip) instead of nesting pre-formatted strings.
 */
export function billedParts(
	costUsd: number | null,
	options: { pricedRequests?: number; precise?: boolean } = {}
): { value: string; note: string | null } {
	const value = formatBilled(costUsd, options);
	return { value, note: value === '—' ? NO_COST_REPORTED : null };
}

/**
 * API-equivalent value of subscription usage, formatted the same way everywhere:
 * "≈ $736.44", with "+" when some records had no known price (a lower bound), and
 * "Not priced" when nothing had a known price.
 */
export function formatApiValue(usd: number, lowerBound: boolean): string {
	if (usd === 0 && lowerBound) return 'Not priced';
	return `≈ ${formatSpend(usd)}${lowerBound ? '+' : ''}`;
}

// ── plan limits ──────────────────────────────────────────────────────────

export function resetLabel(resetsAt: number | null, now: number): string | null {
	if (!resetsAt) return null;
	const ms = resetsAt - now;
	// The stored percentage predates the reset; it's stale until the next sync.
	if (ms <= 0) return 'reset — awaiting sync';
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `resets in ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
	return `resets ${new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(resetsAt)}`;
}

/** The window's reset time has passed, so its stored percentage is from before the reset. */
export function isExpiredWindow(window: CodingUsageLimitWindow, now: number): boolean {
	return window.resetsAt !== null && window.resetsAt <= now;
}

/** Whole percent of a plan-limit window still available (100 − used, clamped to 0–100). */
export function remainingPercent(window: CodingUsageLimitWindow): number {
	return Math.min(100, Math.max(0, Math.round(100 - window.usedPercent)));
}

/** The plan-limit window closest to its cap, across all accounts (expired windows skipped). */
export function mostUsedWindow(
	accounts: UsageAccount[],
	now = Date.now()
): { account: UsageAccount; window: CodingUsageLimitWindow } | null {
	let best: { account: UsageAccount; window: CodingUsageLimitWindow } | null = null;
	for (const account of accounts)
		for (const window of account.windows)
			if (!isExpiredWindow(window, now) && (!best || window.usedPercent > best.window.usedPercent))
				best = { account, window };
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
