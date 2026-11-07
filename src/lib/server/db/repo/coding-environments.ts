import { randomUUID } from 'node:crypto';
import { encryptSecret } from '../../crypto.js';
import type { Db } from '../index.js';
import type {
	CodingEnvironment,
	CodingEnvironmentStatus,
	CodingUsageDailyRow,
	CodingUsageLimitWindow
} from '$lib/coding-environments.js';

export interface CodingEnvironmentRow {
	id: string;
	user_id: string;
	name: string;
	base_url: string;
	token_enc: string;
	enabled: number;
	status: CodingEnvironmentStatus;
	server_version: string | null;
	environment_label: string | null;
	last_error: string | null;
	last_checked_at: number | null;
	last_synced_at: number | null;
	created_at: number;
	updated_at: number;
}

export function toPublic(row: CodingEnvironmentRow): CodingEnvironment {
	return {
		id: row.id,
		name: row.name,
		baseUrl: row.base_url,
		enabled: row.enabled === 1,
		status: row.status,
		serverVersion: row.server_version,
		environmentLabel: row.environment_label,
		lastError: row.last_error,
		lastCheckedAt: row.last_checked_at,
		lastSyncedAt: row.last_synced_at,
		createdAt: row.created_at
	};
}

/** Strips trailing slashes so `${baseUrl}/path` joins cleanly. */
export function normalizeBaseUrl(url: string): string {
	return url.trim().replace(/\/+$/, '');
}

export function listCodingEnvironments(db: Db, userId: string): CodingEnvironmentRow[] {
	return db
		.prepare('SELECT * FROM coding_environments WHERE user_id = ? ORDER BY created_at')
		.all(userId) as CodingEnvironmentRow[];
}

/** Coding environments one user may connect (each one is polled and watched). */
export const MAX_CODING_ENVIRONMENTS_PER_USER = 20;

export function countCodingEnvironments(db: Db, userId: string): number {
	const row = db
		.prepare('SELECT COUNT(*) AS n FROM coding_environments WHERE user_id = ?')
		.get(userId) as { n: number };
	return row.n;
}

export function listEnabledCodingEnvironments(db: Db): CodingEnvironmentRow[] {
	return db
		.prepare('SELECT * FROM coding_environments WHERE enabled = 1 ORDER BY created_at')
		.all() as CodingEnvironmentRow[];
}

export function getCodingEnvironment(
	db: Db,
	userId: string,
	id: string
): CodingEnvironmentRow | undefined {
	return db
		.prepare('SELECT * FROM coding_environments WHERE id = ? AND user_id = ?')
		.get(id, userId) as CodingEnvironmentRow | undefined;
}

export interface CreateCodingEnvironmentInput {
	name: string;
	baseUrl: string;
	token: string;
	enabled?: boolean;
}

export function createCodingEnvironment(
	db: Db,
	userId: string,
	input: CreateCodingEnvironmentInput
): CodingEnvironmentRow {
	const id = randomUUID();
	const now = Date.now();
	db.prepare(
		`INSERT INTO coding_environments (id, user_id, name, base_url, token_enc, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		userId,
		input.name,
		normalizeBaseUrl(input.baseUrl),
		encryptSecret(input.token),
		input.enabled === false ? 0 : 1,
		now,
		now
	);
	return getCodingEnvironment(db, userId, id)!;
}

export interface UpdateCodingEnvironmentInput {
	name?: string;
	baseUrl?: string;
	/** Undefined keeps the stored token; a string replaces it. */
	token?: string;
	enabled?: boolean;
}

export function updateCodingEnvironment(
	db: Db,
	userId: string,
	id: string,
	patch: UpdateCodingEnvironmentInput
): CodingEnvironmentRow | undefined {
	const existing = getCodingEnvironment(db, userId, id);
	if (!existing) return undefined;
	const connectionChanged =
		(patch.baseUrl !== undefined && normalizeBaseUrl(patch.baseUrl) !== existing.base_url) ||
		patch.token !== undefined;
	db.prepare(
		`UPDATE coding_environments SET name = ?, base_url = ?, token_enc = ?, enabled = ?,
		 status = ?, last_error = ?, updated_at = ?
		 WHERE id = ? AND user_id = ?`
	).run(
		patch.name ?? existing.name,
		patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : existing.base_url,
		patch.token !== undefined ? encryptSecret(patch.token) : existing.token_enc,
		patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
		connectionChanged ? 'unknown' : existing.status,
		connectionChanged ? null : existing.last_error,
		Date.now(),
		id,
		userId
	);
	return getCodingEnvironment(db, userId, id);
}

export interface DeletedCodingEnvironment {
	/** Tasks of the environment that were settled by the removal. */
	settledIds: string[];
	/** Tasks that were still live (starting, running, awaiting input) and got ended. */
	endedIds: string[];
	/** Every task that was linked to the environment. */
	taskIds: string[];
}

/**
 * Deletes an environment. Its tasks can no longer be reached, so they are all
 * marked as done first: live ones are ended (status `idle`, no pending request
 * or run timer) and every task is settled. Returns undefined when not found.
 */
export function deleteCodingEnvironment(
	db: Db,
	userId: string,
	id: string
): DeletedCodingEnvironment | undefined {
	return db.transaction(() => {
		if (!getCodingEnvironment(db, userId, id)) return undefined;
		const tasks = db
			.prepare(
				`SELECT cc.conversation_id AS id, cc.status, c.settled_at
				 FROM coding_conversations cc
				 JOIN conversations c ON c.id = cc.conversation_id
				 WHERE cc.environment_id = ? AND c.user_id = ? AND c.deleted_at IS NULL`
			)
			.all(id, userId) as { id: string; status: string; settled_at: number | null }[];
		const now = Date.now();
		const endTask = db.prepare(
			`UPDATE coding_conversations SET status = 'idle', pending_request = NULL,
			   run_started_at = NULL, updated_at = ?
			 WHERE conversation_id = ?`
		);
		const settle = db.prepare(
			`UPDATE conversations SET settled_at = ?, settled_reason = 'manual', pinned = 0
			 WHERE id = ? AND settled_at IS NULL`
		);
		const endedIds: string[] = [];
		const settledIds: string[] = [];
		for (const task of tasks) {
			if (
				task.status === 'starting' ||
				task.status === 'running' ||
				task.status === 'awaiting_input'
			) {
				endTask.run(now, task.id);
				endedIds.push(task.id);
			}
			if (task.settled_at === null && settle.run(now, task.id).changes > 0) {
				settledIds.push(task.id);
			}
		}
		db.prepare('DELETE FROM coding_environments WHERE id = ? AND user_id = ?').run(id, userId);
		return { settledIds, endedIds, taskIds: tasks.map((t) => t.id) };
	})();
}

export interface EnvironmentCheckResult {
	status: CodingEnvironmentStatus;
	serverVersion?: string | null;
	environmentLabel?: string | null;
	error?: string | null;
	synced?: boolean;
}

export function recordEnvironmentCheck(db: Db, id: string, result: EnvironmentCheckResult): void {
	const now = Date.now();
	db.prepare(
		`UPDATE coding_environments SET status = ?,
		   server_version = COALESCE(?, server_version),
		   environment_label = COALESCE(?, environment_label),
		   last_error = ?, last_checked_at = ?,
		   last_synced_at = CASE WHEN ? THEN ? ELSE last_synced_at END
		 WHERE id = ?`
	).run(
		result.status,
		result.serverVersion ?? null,
		result.environmentLabel ?? null,
		result.error ?? null,
		now,
		result.synced ? 1 : 0,
		now,
		id
	);
}

// ── usage ────────────────────────────────────────────────────────────────

/** Replaces every stored limit window for an environment with a fresh snapshot. */
export function replaceUsageLimits(
	db: Db,
	environmentId: string,
	windows: Omit<CodingUsageLimitWindow, 'environmentId'>[]
): void {
	const insert = db.prepare(
		`INSERT INTO coding_usage_limits (environment_id, account_id, provider, account_label,
		   account_email, account_plan, window_id, window_kind, window_label, used_percent, resets_at, checked_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (environment_id, account_id, window_id) DO UPDATE SET
		   provider = excluded.provider, account_label = excluded.account_label,
		   account_email = excluded.account_email, account_plan = excluded.account_plan,
		   window_kind = excluded.window_kind, window_label = excluded.window_label,
		   used_percent = excluded.used_percent, resets_at = excluded.resets_at,
		   checked_at = excluded.checked_at`
	);
	db.transaction(() => {
		db.prepare('DELETE FROM coding_usage_limits WHERE environment_id = ?').run(environmentId);
		for (const w of windows) {
			insert.run(
				environmentId,
				w.accountId,
				w.provider,
				w.accountLabel,
				w.accountEmail,
				w.accountPlan,
				w.windowId,
				w.windowKind,
				w.windowLabel,
				w.usedPercent,
				w.resetsAt,
				w.checkedAt
			);
		}
	})();
}

/** Replaces the daily buckets for `[fromDay, toDay]` (inclusive, YYYY-MM-DD). */
export function replaceUsageDaily(
	db: Db,
	environmentId: string,
	range: { fromDay: string; toDay: string },
	rows: Omit<CodingUsageDailyRow, 'environmentId'>[]
): void {
	const insert = db.prepare(
		`INSERT INTO coding_usage_daily (environment_id, day, provider, model, input_tokens,
		   cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_tokens, cost_usd, priced, sessions)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (environment_id, day, provider, model) DO UPDATE SET
		   input_tokens = input_tokens + excluded.input_tokens,
		   cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
		   cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
		   output_tokens = output_tokens + excluded.output_tokens,
		   reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
		   cost_usd = cost_usd + excluded.cost_usd,
		   priced = MIN(priced, excluded.priced),
		   sessions = sessions + excluded.sessions`
	);
	db.transaction(() => {
		db.prepare(
			'DELETE FROM coding_usage_daily WHERE environment_id = ? AND day >= ? AND day <= ?'
		).run(environmentId, range.fromDay, range.toDay);
		// Buckets can repeat per (day, provider, model) when the server splits them by
		// source path; the upsert sums them.
		for (const r of rows) {
			insert.run(
				environmentId,
				r.day,
				r.provider,
				r.model,
				r.inputTokens,
				r.cachedInputTokens,
				r.cacheCreationTokens,
				r.outputTokens,
				r.reasoningTokens,
				r.costUsd,
				r.priced ? 1 : 0,
				r.sessions
			);
		}
	})();
}

interface UsageLimitDbRow {
	environment_id: string;
	account_id: string;
	provider: string;
	account_label: string;
	account_email: string | null;
	account_plan: string | null;
	window_id: string;
	window_kind: CodingUsageLimitWindow['windowKind'];
	window_label: string;
	used_percent: number;
	resets_at: number | null;
	checked_at: number;
}

export function listUsageLimits(db: Db, userId: string): CodingUsageLimitWindow[] {
	const rows = db
		.prepare(
			`SELECT l.* FROM coding_usage_limits l
			 JOIN coding_environments e ON e.id = l.environment_id
			 WHERE e.user_id = ?
			 ORDER BY e.created_at, l.provider, l.account_label,
			   CASE l.window_kind WHEN 'session' THEN 0 WHEN 'weekly' THEN 1 WHEN 'monthly' THEN 2 ELSE 3 END,
			   l.window_label`
		)
		.all(userId) as UsageLimitDbRow[];
	return rows.map((r) => ({
		environmentId: r.environment_id,
		accountId: r.account_id,
		provider: r.provider,
		accountLabel: r.account_label,
		accountEmail: r.account_email,
		accountPlan: r.account_plan,
		windowId: r.window_id,
		windowKind: r.window_kind,
		windowLabel: r.window_label,
		usedPercent: r.used_percent,
		resetsAt: r.resets_at,
		checkedAt: r.checked_at
	}));
}

interface UsageDailyDbRow {
	environment_id: string;
	day: string;
	provider: string;
	model: string;
	input_tokens: number;
	cached_input_tokens: number;
	cache_creation_tokens: number;
	output_tokens: number;
	reasoning_tokens: number;
	cost_usd: number;
	priced: number;
	sessions: number;
}

export function listUsageDaily(db: Db, userId: string, fromDay: string): CodingUsageDailyRow[] {
	const rows = db
		.prepare(
			`SELECT d.* FROM coding_usage_daily d
			 JOIN coding_environments e ON e.id = d.environment_id
			 WHERE e.user_id = ? AND d.day >= ?
			 ORDER BY d.day, d.provider, d.model`
		)
		.all(userId, fromDay) as UsageDailyDbRow[];
	return rows.map((r) => ({
		environmentId: r.environment_id,
		day: r.day,
		provider: r.provider,
		model: r.model,
		inputTokens: r.input_tokens,
		cachedInputTokens: r.cached_input_tokens,
		cacheCreationTokens: r.cache_creation_tokens,
		outputTokens: r.output_tokens,
		reasoningTokens: r.reasoning_tokens,
		costUsd: r.cost_usd,
		priced: r.priced === 1,
		sessions: r.sessions
	}));
}
