import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	listProxyRequests,
	proxyRequestDailyCounts,
	proxyRequestDailyModelCounts,
	proxyRequestStats,
	proxyRequestTopModels,
	toPublic,
	type ProxyRequestFilters
} from '$lib/server/db/repo/proxy-requests.js';
import { getTimeFormat } from '$lib/server/db/repo/user-settings.js';
import { isUsagePeriod, parseUsagePeriod } from '$lib/components/app/usage/usage.js';
import {
	localDays,
	startOfLocalDay,
	utcOffsetMinutes,
	windowForPeriod
} from '../usage-data.server.js';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;
/** Longest span the per-day model chart draws; wider ranges show their most recent days. */
const MAX_CHART_DAYS = 90;

const RANGE_PRESETS = ['24h', '7d', '30d', '90d', 'all', 'custom'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

const RANGE_LABELS: Record<RangePreset, string> = {
	'24h': 'last 24 hours',
	'7d': 'last 7 days',
	'30d': 'last 30 days',
	'90d': 'last 90 days',
	all: 'all time',
	custom: 'selected dates'
};

function isRangePreset(value: string | null): value is RangePreset {
	return (RANGE_PRESETS as readonly string[]).includes(value ?? '');
}

function parseDateStart(value: string): number | undefined {
	if (!value) return undefined;
	const ms = Date.parse(`${value}T00:00:00`);
	return Number.isNaN(ms) ? undefined : ms;
}

export const load: PageServerLoad = ({ locals, url }) => {
	const user = requireUser(locals);
	// Admins see everyone's requests; everyone else only ever sees their own.
	const isAdmin = (user as { role?: string }).role === 'admin';
	const db = getDb();

	// Without an explicit range, the log follows the Usage section's shared period.
	const periodParam = url.searchParams.get('period');
	const period = parseUsagePeriod(periodParam);
	const defaultRange: RangePreset = period;

	const searchFilter = url.searchParams.get('search') ?? '';
	const userFilter = isAdmin ? (url.searchParams.get('user') ?? '') : '';
	const providerFilter = url.searchParams.get('provider') ?? '';
	const keyFilter = url.searchParams.get('key') ?? '';
	const modelFilter = url.searchParams.get('model') ?? '';
	const statusFilter = url.searchParams.get('status') ?? '';
	const endpointFilter = url.searchParams.get('endpoint') ?? '';
	const sourceFilter = url.searchParams.get('source') ?? '';
	const rangeParam = url.searchParams.get('range');
	// Bare `from`/`to` (old links) imply a custom range; nothing at all means the default.
	const range: RangePreset = isRangePreset(rangeParam)
		? rangeParam
		: url.searchParams.has('from') || url.searchParams.has('to')
			? 'custom'
			: defaultRange;
	const fromFilter = range === 'custom' ? (url.searchParams.get('from') ?? '') : '';
	const toFilter = range === 'custom' ? (url.searchParams.get('to') ?? '') : '';

	const filters: ProxyRequestFilters = {};
	if (!isAdmin) filters.userId = user.id;
	else if (userFilter) filters.userId = userFilter;
	if (providerFilter) filters.providerId = providerFilter;
	if (keyFilter) filters.apiKeyId = keyFilter;
	if (modelFilter) filters.model = modelFilter;
	if (statusFilter) filters.status = statusFilter;
	if (endpointFilter) filters.endpoint = endpointFilter;
	if (sourceFilter) filters.source = sourceFilter;
	if (searchFilter) filters.search = searchFilter;
	const nowMs = Date.now();
	if (range === '24h') filters.from = nowMs - DAY_MS;
	else if (isUsagePeriod(range)) {
		// Whole local days, exactly the window the Overview totals use.
		filters.from = windowForPeriod(range, nowMs).startMs;
	} else if (range === 'custom') {
		const fromMs = parseDateStart(fromFilter);
		if (fromMs !== undefined) filters.from = fromMs;
		const toMs = parseDateStart(toFilter);
		if (toMs !== undefined) filters.to = toMs + 86399999;
	}

	const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const { rows, total } = listProxyRequests(db, filters, PAGE_SIZE, (page - 1) * PAGE_SIZE);
	const requests = rows.map(toPublic);
	const stats = proxyRequestStats(db, filters);
	// The activity heatmap shows recent months regardless of the selected range.
	const unbounded: ProxyRequestFilters = { ...filters };
	delete unbounded.from;
	delete unbounded.to;
	const dailyCounts = proxyRequestDailyCounts(db, 365, unbounded);
	const topModels = proxyRequestTopModels(db, 10, filters);

	// Day axis for the per-model chart: the selected range in local days, capped to its last
	// MAX_CHART_DAYS.
	const axisEndMs = Math.min(filters.to ?? nowMs, nowMs);
	const axisStartMs = Math.max(
		startOfLocalDay(filters.from ?? 0),
		startOfLocalDay(axisEndMs - (MAX_CHART_DAYS - 1) * DAY_MS)
	);
	const days = localDays(axisStartMs, axisEndMs);

	const dailyModelRows = proxyRequestDailyModelCounts(
		db,
		Math.ceil((nowMs - axisStartMs) / DAY_MS) + 1,
		filters,
		utcOffsetMinutes(nowMs)
	);
	const topModelNames = new Set(topModels.slice(0, 5).map((m) => m.model));
	const modelCountsByDay = new Map<string, Map<string, number>>();
	const allModels = new Set<string>();
	for (const row of dailyModelRows) {
		if (!modelCountsByDay.has(row.day)) modelCountsByDay.set(row.day, new Map());
		const dayMap = modelCountsByDay.get(row.day)!;
		const key = topModelNames.has(row.model) ? row.model : 'Other';
		dayMap.set(key, (dayMap.get(key) ?? 0) + row.count);
		allModels.add(key);
	}

	const modelSeries = topModels.slice(0, 5).map((m) => m.model);
	if (allModels.has('Other')) modelSeries.push('Other');

	const stackedRows = days.map((day) => {
		const dayMap = modelCountsByDay.get(day) ?? new Map();
		const row: Record<string, string | number> = { day };
		for (const model of modelSeries) {
			row[model] = dayMap.get(model) ?? 0;
		}
		return row;
	});

	const stackedSeries = modelSeries.map((model) => ({ key: model, label: model }));

	const users: Record<string, string> = {};
	const userIds = [...new Set(requests.map((r) => r.userId))];
	if (userIds.length > 0) {
		const placeholders = userIds.map(() => '?').join(', ');
		const userRows = db
			.prepare(`SELECT id, name, email FROM "user" WHERE id IN (${placeholders})`)
			.all(...userIds) as { id: string; name: string; email: string }[];
		for (const row of userRows) users[row.id] = row.name || row.email;
	}

	const keys: Record<string, string> = {};
	const keyIds = [
		...new Set(requests.map((r) => r.apiKeyId).filter((id): id is string => id !== null))
	];
	if (keyIds.length > 0) {
		const placeholders = keyIds.map(() => '?').join(', ');
		const keyRows = db
			.prepare(`SELECT id, label FROM api_keys WHERE id IN (${placeholders})`)
			.all(...keyIds) as { id: string; label: string }[];
		for (const row of keyRows) keys[row.id] = row.label;
	}

	// Filter options only ever list values from requests the viewer may see.
	const scope = isAdmin ? '' : 'WHERE pr.user_id = ?';
	const scopeArgs = isAdmin ? [] : [user.id];
	const optionUsers = isAdmin
		? (db
				.prepare(
					`SELECT DISTINCT u.id, u.name, u.email FROM proxy_requests pr
					 JOIN "user" u ON u.id = pr.user_id ORDER BY u.name`
				)
				.all() as { id: string; name: string; email: string }[])
		: [];
	const optionKeys = db
		.prepare(
			`SELECT DISTINCT k.id, k.label FROM proxy_requests pr
			 JOIN api_keys k ON k.id = pr.api_key_id ${scope} ORDER BY k.label`
		)
		.all(...scopeArgs) as { id: string; label: string }[];
	const optionModels = db
		.prepare(`SELECT DISTINCT pr.requested_model FROM proxy_requests pr ${scope} ORDER BY 1`)
		.all(...scopeArgs) as { requested_model: string }[];
	const optionEndpoints = db
		.prepare(`SELECT DISTINCT pr.endpoint FROM proxy_requests pr ${scope} ORDER BY 1`)
		.all(...scopeArgs) as { endpoint: string }[];
	const optionProviders = db
		.prepare(
			`SELECT DISTINCT pr.provider_id AS id, p.name FROM proxy_requests pr
			 LEFT JOIN providers p ON p.id = pr.provider_id
			 ${scope ? `${scope} AND` : 'WHERE'} pr.provider_id IS NOT NULL
			 ORDER BY COALESCE(p.name, pr.provider_id)`
		)
		.all(...scopeArgs) as { id: string; name: string | null }[];

	return {
		requests,
		stats,
		dailyCounts,
		topModels,
		stackedRows,
		stackedSeries,
		users,
		keys,
		isAdmin,
		viewerId: user.id,
		period,
		filters: {
			period: isUsagePeriod(periodParam) ? periodParam : '',
			search: searchFilter,
			user: userFilter,
			provider: providerFilter,
			key: keyFilter,
			model: modelFilter,
			status: statusFilter,
			endpoint: endpointFilter,
			source: sourceFilter,
			range: range === defaultRange ? '' : range,
			from: fromFilter,
			to: toFilter
		},
		range,
		rangeLabel: RANGE_LABELS[range],
		chartDaysCapped: (filters.from ?? 0) < axisStartMs,
		page,
		totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
		pageSize: PAGE_SIZE,
		totalResults: total,
		timeFormat: getTimeFormat(db, user.id),
		filterOptions: {
			users: optionUsers.map((u) => ({ id: u.id, name: u.name || u.email })),
			providers: optionProviders.map((p) => ({ id: p.id, name: p.name ?? p.id })),
			keys: optionKeys.map((k) => ({ id: k.id, label: k.label })),
			models: optionModels.map((m) => m.requested_model),
			endpoints: optionEndpoints.map((e) => e.endpoint),
			sources: ['proxy', 'chat', 'agent'],
			statuses: ['complete', 'failed', 'running']
		}
	};
};
