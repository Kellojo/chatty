import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	listProxyRequests,
	proxyRequestDailyCounts,
	proxyRequestStats,
	proxyRequestTopModels,
	toPublic,
	type ProxyRequestFilters
} from '$lib/server/db/repo/proxy-requests.js';
import { getTimeFormat } from '$lib/server/db/repo/user-settings.js';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;

function parseDateStart(value: string): number | undefined {
	if (!value) return undefined;
	const ms = Date.parse(`${value}T00:00:00`);
	return Number.isNaN(ms) ? undefined : ms;
}

export const load: PageServerLoad = ({ locals, url }) => {
	const user = requireAdmin(locals);
	const db = getDb();

	const userFilter = url.searchParams.get('user') ?? '';
	const keyFilter = url.searchParams.get('key') ?? '';
	const modelFilter = url.searchParams.get('model') ?? '';
	const statusFilter = url.searchParams.get('status') ?? '';
	const endpointFilter = url.searchParams.get('endpoint') ?? '';
	const sourceFilter = url.searchParams.get('source') ?? '';
	const fromFilter = url.searchParams.get('from') ?? '';
	const toFilter = url.searchParams.get('to') ?? '';

	const filters: ProxyRequestFilters = {};
	if (userFilter) filters.userId = userFilter;
	if (keyFilter) filters.apiKeyId = keyFilter;
	if (modelFilter) filters.model = modelFilter;
	if (statusFilter) filters.status = statusFilter;
	if (endpointFilter) filters.endpoint = endpointFilter;
	if (sourceFilter) filters.source = sourceFilter;
	const fromMs = parseDateStart(fromFilter);
	if (fromMs !== undefined) filters.from = fromMs;
	const toMs = parseDateStart(toFilter);
	if (toMs !== undefined) filters.to = toMs + 86399999;

	const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const { rows, total } = listProxyRequests(db, filters, PAGE_SIZE, (page - 1) * PAGE_SIZE);
	const requests = rows.map(toPublic);
	const stats = proxyRequestStats(db, filters);
	const dailyCounts = proxyRequestDailyCounts(db, 365, filters);
	const topModels = proxyRequestTopModels(db, 10, filters);

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

	const optionUsers = db
		.prepare(
			`SELECT DISTINCT u.id, u.name, u.email FROM proxy_requests pr
			 JOIN "user" u ON u.id = pr.user_id ORDER BY u.name`
		)
		.all() as { id: string; name: string; email: string }[];
	const optionKeys = db
		.prepare(
			`SELECT DISTINCT k.id, k.label FROM proxy_requests pr
			 JOIN api_keys k ON k.id = pr.api_key_id ORDER BY k.label`
		)
		.all() as { id: string; label: string }[];
	const optionModels = db
		.prepare('SELECT DISTINCT requested_model FROM proxy_requests ORDER BY 1')
		.all() as { requested_model: string }[];

	return {
		requests,
		stats,
		dailyCounts,
		topModels,
		users,
		keys,
		filters: {
			user: userFilter,
			key: keyFilter,
			model: modelFilter,
			status: statusFilter,
			endpoint: endpointFilter,
			source: sourceFilter,
			from: fromFilter,
			to: toFilter
		},
		page,
		totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
		timeFormat: getTimeFormat(db, user.id),
		filterOptions: {
			users: optionUsers.map((u) => ({ id: u.id, name: u.name || u.email })),
			keys: optionKeys.map((k) => ({ id: k.id, label: k.label })),
			models: optionModels.map((m) => m.requested_model),
			sources: ['proxy', 'chat', 'agent']
		}
	};
};
