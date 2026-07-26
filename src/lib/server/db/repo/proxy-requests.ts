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
	costUsd?: number | null;
	error?: string | null;
	compression?: ProxyCompression | null;
}

export function finalizeProxyRequest(db: Db, id: string, patch: FinalizeProxyRequestInput): void {
	db.prepare(
		`UPDATE proxy_requests SET status = ?, http_status = ?, latency_ms = ?, mapping_id = ?,
		 provider_id = ?, model_id = ?, fallback_index = ?, input_tokens = ?, output_tokens = ?,
		 cost_usd = ?, error = ?, compression = ?
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
	status?: string;
	endpoint?: string;
	source?: string;
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
	filters: ProxyRequestFilters = {}
): DailyCount[] {
	const { where, args } = buildWhere(filters);
	const from = Date.now() - days * 86400000;
	const extra = where ? ` AND started_at >= ?` : 'WHERE started_at >= ?';
	return db
		.prepare(
			`SELECT date(started_at / 1000, 'unixepoch') AS day,
				COUNT(*) AS count,
				SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
			 FROM proxy_requests ${where}${extra}
			 GROUP BY day ORDER BY day`
		)
		.all(...args, from) as DailyCount[];
}

export interface ModelUsage {
	model: string;
	count: number;
	totalTokens: number;
	costUsd: number;
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
		avg_latency: number | null;
	}[];
	return rows.map((r) => ({
		model: r.model,
		count: r.count,
		totalTokens: r.total_tokens,
		costUsd: r.cost_usd,
		avgLatencyMs: r.avg_latency
	}));
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
