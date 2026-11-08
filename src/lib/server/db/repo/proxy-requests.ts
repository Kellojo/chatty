import { randomUUID } from 'node:crypto';
import type {
	ProxyCompression,
	ProxyRequest,
	ProxyRequestStatus,
	RequestPurpose,
	RequestSource
} from '$lib/types.js';
import { publishServerEvent } from '../../events/bus.js';
import type { Db } from '../index.js';

export interface ProxyRequestRow {
	id: string;
	user_id: string;
	api_key_id: string | null;
	endpoint: string;
	requested_model: string;
	mapping_id: string | null;
	provider_id: string | null;
	model_id: string | null;
	fallback_index: number;
	status: string;
	http_status: number | null;
	started_at: number;
	latency_ms: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	cost_usd: number | null;
	stream: number;
	error: string | null;
	compression: string | null;
	source: string;
	conversation_id: string | null;
	run_id: string | null;
	message_id: string | null;
	step_index: number;
	purpose: string;
}

export function toPublic(row: ProxyRequestRow): ProxyRequest {
	return {
		id: row.id,
		userId: row.user_id,
		apiKeyId: row.api_key_id,
		endpoint: row.endpoint,
		requestedModel: row.requested_model,
		mappingId: row.mapping_id,
		providerId: row.provider_id,
		modelId: row.model_id,
		fallbackIndex: row.fallback_index,
		status: row.status as ProxyRequestStatus,
		httpStatus: row.http_status,
		startedAt: row.started_at,
		latencyMs: row.latency_ms,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		cacheReadTokens: row.cache_read_tokens ?? null,
		cacheWriteTokens: row.cache_write_tokens ?? null,
		costUsd: row.cost_usd,
		stream: row.stream === 1,
		error: row.error,
		compression: row.compression ? (JSON.parse(row.compression) as ProxyCompression) : null,
		source: row.source as ProxyRequest['source'],
		conversationId: row.conversation_id,
		runId: row.run_id,
		messageId: row.message_id,
		stepIndex: row.step_index,
		purpose: row.purpose as ProxyRequest['purpose']
	};
}

export interface CreateProxyRequestInput {
	userId: string;
	apiKeyId?: string | null;
	endpoint: string;
	requestedModel: string;
	stream: boolean;
	source?: RequestSource;
	conversationId?: string | null;
	runId?: string | null;
	messageId?: string | null;
	stepIndex?: number;
	purpose?: RequestPurpose;
}

export function createProxyRequest(db: Db, input: CreateProxyRequestInput): ProxyRequestRow {
	const id = randomUUID();
	db.prepare(
		`INSERT INTO proxy_requests (id, user_id, api_key_id, endpoint, requested_model, status, started_at, stream, source, conversation_id, run_id, message_id, step_index, purpose)
		 VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		input.userId,
		input.apiKeyId ?? null,
		input.endpoint,
		input.requestedModel,
		Date.now(),
		input.stream ? 1 : 0,
		input.source ?? 'proxy',
		input.conversationId ?? null,
		input.runId ?? null,
		input.messageId ?? null,
		input.stepIndex ?? 0,
		input.purpose ?? 'completion'
	);
	publishServerEvent(input.userId, { type: 'proxy.request.started', requestId: id });
	return getProxyRequest(db, id)!;
}

export interface FinalizeProxyRequestInput {
	status: 'complete' | 'failed';
	httpStatus?: number | null;
	latencyMs?: number | null;
	mappingId?: string | null;
	providerId?: string | null;
	modelId?: string | null;
	fallbackIndex?: number;
	inputTokens?: number | null;
	outputTokens?: number | null;
	cacheReadTokens?: number | null;
	cacheWriteTokens?: number | null;
	costUsd?: number | null;
	error?: string | null;
	compression?: ProxyCompression | null;
}

export function finalizeProxyRequest(db: Db, id: string, patch: FinalizeProxyRequestInput): void {
	db.prepare(
		`UPDATE proxy_requests SET status = ?, http_status = ?, latency_ms = ?, mapping_id = ?,
		 provider_id = ?, model_id = ?, fallback_index = ?, input_tokens = ?, output_tokens = ?,
		 cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?, error = ?, compression = ?
		 WHERE id = ?`
	).run(
		patch.status,
		patch.httpStatus ?? null,
		patch.latencyMs ?? null,
		patch.mappingId ?? null,
		patch.providerId ?? null,
		patch.modelId ?? null,
		patch.fallbackIndex ?? 0,
		patch.inputTokens ?? null,
		patch.outputTokens ?? null,
		patch.cacheReadTokens ?? null,
		patch.cacheWriteTokens ?? null,
		patch.costUsd ?? null,
		patch.error ?? null,
		patch.compression ? JSON.stringify(patch.compression) : null,
		id
	);
	const row = db.prepare('SELECT user_id FROM proxy_requests WHERE id = ?').get(id) as
		{ user_id: string } | undefined;
	if (row) {
		publishServerEvent(row.user_id, {
			type: 'proxy.request.finished',
			requestId: id,
			status: patch.status
		});
	}
}

export function getProxyRequest(db: Db, id: string): ProxyRequestRow | undefined {
	return db.prepare('SELECT * FROM proxy_requests WHERE id = ?').get(id) as
		ProxyRequestRow | undefined;
}

export interface ProxyRequestFilters {
	userId?: string;
	apiKeyId?: string;
	model?: string;
	/** Configured provider the request was served by. */
	providerId?: string;
	status?: string;
	endpoint?: string;
	source?: string;
	search?: string;
	from?: number;
	to?: number;
}

function buildWhere(filters: ProxyRequestFilters): { where: string; args: unknown[] } {
	const clauses: string[] = [];
	const args: unknown[] = [];
	if (filters.userId) {
		clauses.push('user_id = ?');
		args.push(filters.userId);
	}
	if (filters.apiKeyId) {
		clauses.push('api_key_id = ?');
		args.push(filters.apiKeyId);
	}
	if (filters.model) {
		clauses.push('requested_model = ?');
		args.push(filters.model);
	}
	if (filters.providerId) {
		clauses.push('provider_id = ?');
		args.push(filters.providerId);
	}
	if (filters.status) {
		clauses.push('status = ?');
		args.push(filters.status);
	}
	if (filters.endpoint) {
		clauses.push('endpoint = ?');
		args.push(filters.endpoint);
	}
	if (filters.source) {
		clauses.push('source = ?');
		args.push(filters.source);
	}
	if (filters.search) {
		const term = `%${filters.search}%`;
		clauses.push(
			'(requested_model LIKE ? OR endpoint LIKE ? OR provider_id LIKE ? OR model_id LIKE ? OR error LIKE ?)'
		);
		args.push(term, term, term, term, term);
	}
	if (filters.from !== undefined) {
		clauses.push('started_at >= ?');
		args.push(filters.from);
	}
	if (filters.to !== undefined) {
		clauses.push('started_at <= ?');
		args.push(filters.to);
	}
	return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

export function listProxyRequests(
	db: Db,
	filters: ProxyRequestFilters = {},
	limit = 50,
	offset = 0
): { rows: ProxyRequestRow[]; total: number } {
	const { where, args } = buildWhere(filters);
	const total = (
		db.prepare(`SELECT COUNT(*) AS n FROM proxy_requests ${where}`).get(...args) as { n: number }
	).n;
	const rows = db
		.prepare(`SELECT * FROM proxy_requests ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
		.all(...args, limit, offset) as ProxyRequestRow[];
	return { rows, total };
}

export interface ProxyRequestStats {
	total: number;
	completed: number;
	failed: number;
	avgLatencyMs: number | null;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	/** Requests that reported a cost (possibly 0). */
	pricedRequests: number;
	distinctModels: number;
	cavemanSaved: number;
}

export function proxyRequestStats(db: Db, filters: ProxyRequestFilters = {}): ProxyRequestStats {
	const { where, args } = buildWhere(filters);
	const row = db
		.prepare(
			`SELECT COUNT(*) AS total,
				SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
				AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END) AS avg_latency,
				COALESCE(SUM(input_tokens), 0) AS input_tokens,
				COALESCE(SUM(output_tokens), 0) AS output_tokens,
				COALESCE(SUM(cost_usd), 0) AS cost_usd,
				COUNT(cost_usd) AS priced_requests,
				COUNT(DISTINCT requested_model) AS distinct_models,
			COALESCE(SUM(CAST(json_extract(compression, '$.caveman.estSaved') AS INTEGER)), 0) AS caveman_saved
		 FROM proxy_requests ${where}`
		)
		.get(...args) as {
		total: number;
		completed: number | null;
		failed: number | null;
		avg_latency: number | null;
		input_tokens: number;
		output_tokens: number;
		cost_usd: number;
		priced_requests: number;
		distinct_models: number;
		caveman_saved: number;
	};
	return {
		total: row.total,
		completed: row.completed ?? 0,
		failed: row.failed ?? 0,
		avgLatencyMs: row.avg_latency,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		costUsd: row.cost_usd,
		pricedRequests: row.priced_requests,
		distinctModels: row.distinct_models,
		cavemanSaved: row.caveman_saved
	};
}

export interface DailyCount {
	day: string;
	count: number;
	completed: number;
	failed: number;
}

export function proxyRequestDailyCounts(
	db: Db,
	days: number,
	filters: ProxyRequestFilters = {},
	utcOffsetMinutes = 0
): DailyCount[] {
	const { where, args } = buildWhere(filters);
	const from = Date.now() - days * 86400000;
	const extra = where ? ` AND started_at >= ?` : 'WHERE started_at >= ?';
	return db
		.prepare(
			`SELECT date(started_at / 1000 + ?, 'unixepoch') AS day,
				COUNT(*) AS count,
				SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
			 FROM proxy_requests ${where}${extra}
			 GROUP BY day ORDER BY day`
		)
		.all(utcOffsetMinutes * 60, ...args, from) as DailyCount[];
}

export interface ModelUsage {
	model: string;
	count: number;
	totalTokens: number;
	costUsd: number;
	/** Requests that reported a cost (possibly 0). */
	pricedRequests: number;
	avgLatencyMs: number | null;
}

export function proxyRequestTopModels(
	db: Db,
	limit = 10,
	filters: ProxyRequestFilters = {}
): ModelUsage[] {
	const { where, args } = buildWhere(filters);
	const rows = db
		.prepare(
			`SELECT requested_model AS model,
				COUNT(*) AS count,
				COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total_tokens,
				COALESCE(SUM(cost_usd), 0) AS cost_usd,
				COUNT(cost_usd) AS priced_requests,
				AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END) AS avg_latency
			 FROM proxy_requests ${where}
			 GROUP BY requested_model
			 ORDER BY count DESC
			 LIMIT ?`
		)
		.all(...args, limit) as {
		model: string;
		count: number;
		total_tokens: number;
		cost_usd: number;
		priced_requests: number;
		avg_latency: number | null;
	}[];
	return rows.map((r) => ({
		model: r.model,
		count: r.count,
		totalTokens: r.total_tokens,
		costUsd: r.cost_usd,
		pricedRequests: r.priced_requests,
		avgLatencyMs: r.avg_latency
	}));
}

export interface DailyModelCount {
	day: string;
	model: string;
	count: number;
}

export function proxyRequestDailyModelCounts(
	db: Db,
	days: number,
	filters: ProxyRequestFilters = {},
	utcOffsetMinutes = 0
): DailyModelCount[] {
	const { where, args } = buildWhere(filters);
	const from = Date.now() - days * 86400000;
	const extra = where ? ' AND started_at >= ?' : 'WHERE started_at >= ?';
	return db
		.prepare(
			`SELECT date(started_at / 1000 + ?, 'unixepoch') AS day,
			        requested_model AS model,
			        COUNT(*) AS count
			 FROM proxy_requests ${where}${extra}
			 GROUP BY day, requested_model
			 ORDER BY day, count DESC`
		)
		.all(utcOffsetMinutes * 60, ...args, from) as DailyModelCount[];
}

export interface ProviderModelDailyUsage {
	day: string;
	providerId: string | null;
	/** Display name of the configured provider; null when unset or since deleted. */
	providerName: string | null;
	model: string;
	requests: number;
	/** Requests that reported a cost (possibly 0); the rest had no known price. */
	pricedRequests: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

/**
 * Actual spend through Chatty's configured providers, bucketed per day, provider and
 * served model. `utcOffsetMinutes` shifts the day boundary into the caller's time zone.
 */
export function proxyRequestProviderUsage(
	db: Db,
	filters: ProxyRequestFilters = {},
	utcOffsetMinutes = 0
): ProviderModelDailyUsage[] {
	const { where, args } = buildWhere(filters);
	const rows = db
		.prepare(
			`SELECT date(pr.started_at / 1000 + ?, 'unixepoch') AS day,
				pr.provider_id AS provider_id,
				p.name AS provider_name,
				COALESCE(pr.model_id, pr.requested_model) AS model,
				COUNT(*) AS requests,
				COUNT(pr.cost_usd) AS priced_requests,
				COALESCE(SUM(pr.input_tokens), 0) AS input_tokens,
				COALESCE(SUM(pr.output_tokens), 0) AS output_tokens,
				COALESCE(SUM(pr.cost_usd), 0) AS cost_usd
			 FROM proxy_requests pr
			 LEFT JOIN providers p ON p.id = pr.provider_id
			 ${where}
			 GROUP BY day, pr.provider_id, model
			 ORDER BY day, cost_usd DESC`
		)
		.all(utcOffsetMinutes * 60, ...args) as {
		day: string;
		provider_id: string | null;
		provider_name: string | null;
		model: string;
		requests: number;
		priced_requests: number;
		input_tokens: number;
		output_tokens: number;
		cost_usd: number;
	}[];
	return rows.map((r) => ({
		day: r.day,
		providerId: r.provider_id,
		providerName: r.provider_name,
		model: r.model,
		requests: r.requests,
		pricedRequests: r.priced_requests,
		inputTokens: r.input_tokens,
		outputTokens: r.output_tokens,
		costUsd: r.cost_usd
	}));
}

/** When the earliest matching request started, or null when there is none. */
export function proxyRequestFirstStartedAt(
	db: Db,
	filters: ProxyRequestFilters = {}
): number | null {
	const { where, args } = buildWhere(filters);
	const row = db
		.prepare(`SELECT MIN(started_at) AS first FROM proxy_requests ${where}`)
		.get(...args) as { first: number | null };
	return row.first;
}

export function failRunningProxyRequests(db: Db): number {
	return db
		.prepare(
			`UPDATE proxy_requests SET status = 'failed', error = 'Interrupted by server restart',
			 latency_ms = ? - started_at
			 WHERE status = 'running'`
		)
		.run(Date.now()).changes;
}
