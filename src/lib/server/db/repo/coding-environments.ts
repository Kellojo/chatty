import { randomUUID } from 'node:crypto';
import { encryptSecret } from '../../crypto.js';
import type { Db } from '../index.js';
import type {
	CodingEnvironment,
	CodingEnvironmentStatus,
	CodingResetCredits,
	CodingUsageDailyRow,
	CodingUsageLimitSample,
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
	/** Id the remote server reports for itself; null until first reached. */
	remote_environment_id: string | null;
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

/**
 * An environment of the user that is the same T3 server as the given one: same
 * base URL, or same server-reported environment id. `excludeId` skips the
 * environment being edited.
 */
export function findDuplicateCodingEnvironment(
	db: Db,
	userId: string,
	target: { baseUrl: string; remoteEnvironmentId?: string | null },
	excludeId?: string
): CodingEnvironmentRow | undefined {
	return db
		.prepare(
			`SELECT * FROM coding_environments
			 WHERE user_id = ? AND id IS NOT ?
			   AND (lower(base_url) = lower(?) OR (? IS NOT NULL AND remote_environment_id = ?))
			 ORDER BY created_at LIMIT 1`
		)
		.get(
			userId,
			excludeId ?? null,
			normalizeBaseUrl(target.baseUrl),
			target.remoteEnvironmentId ?? null,
			target.remoteEnvironmentId ?? null
		) as CodingEnvironmentRow | undefined;
}

export interface CreateCodingEnvironmentInput {
	name: string;
	baseUrl: string;
	token: string;
	enabled?: boolean;
	remoteEnvironmentId?: string | null;
}

export function createCodingEnvironment(
	db: Db,
	userId: string,
	input: CreateCodingEnvironmentInput
): CodingEnvironmentRow {
	const id = randomUUID();
	const now = Date.now();
	db.prepare(
		`INSERT INTO coding_environments (id, user_id, name, base_url, token_enc, enabled,
		   remote_environment_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		userId,
		input.name,
		normalizeBaseUrl(input.baseUrl),
		encryptSecret(input.token),
		input.enabled === false ? 0 : 1,
		input.remoteEnvironmentId ?? null,
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
	/**
	 * The new server's id when known. A changed URL otherwise clears the stored
	 * one: it may belong to a different server.
	 */
	remoteEnvironmentId?: string | null;
}

export function updateCodingEnvironment(
	db: Db,
	userId: string,
	id: string,
	patch: UpdateCodingEnvironmentInput
): CodingEnvironmentRow | undefined {
	const existing = getCodingEnvironment(db, userId, id);
	if (!existing) return undefined;
	const urlChanged =
		patch.baseUrl !== undefined && normalizeBaseUrl(patch.baseUrl) !== existing.base_url;
	const connectionChanged = urlChanged || patch.token !== undefined;
	const remoteEnvironmentId =
		patch.remoteEnvironmentId !== undefined
			? patch.remoteEnvironmentId
			: urlChanged
				? null
				: existing.remote_environment_id;
	db.prepare(
		`UPDATE coding_environments SET name = ?, base_url = ?, token_enc = ?, enabled = ?,
		 remote_environment_id = ?, status = ?, last_error = ?, updated_at = ?
		 WHERE id = ? AND user_id = ?`
	).run(
		patch.name ?? existing.name,
		patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : existing.base_url,
		patch.token !== undefined ? encryptSecret(patch.token) : existing.token_enc,
		patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
		remoteEnvironmentId,
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
	remoteEnvironmentId?: string | null;
	error?: string | null;
	synced?: boolean;
}

/** Shown on the newer of two environments that turned out to be the same T3 server. */
export function duplicateEnvironmentError(otherName: string): string {
	return `Same T3 server as "${otherName}" — remove one`;
}

/**
 * Records the outcome of reaching an environment. When a successful check
 * reports a server id another environment of the same user already has (the
 * same server, connected twice), the newer of the two is marked as an error
 * naming the older one, instead of both quietly syncing the same server.
 */
export function recordEnvironmentCheck(db: Db, id: string, result: EnvironmentCheckResult): void {
	db.transaction(() => {
		writeEnvironmentCheck(db, id, result);
		if (result.status === 'online' && result.remoteEnvironmentId) {
			flagDuplicateEnvironments(db, id, result.remoteEnvironmentId);
		}
	})();
}

function flagDuplicateEnvironments(db: Db, id: string, remoteEnvironmentId: string): void {
	const self = db.prepare('SELECT * FROM coding_environments WHERE id = ?').get(id) as
		CodingEnvironmentRow | undefined;
	if (!self) return;
	const others = db
		.prepare(
			`SELECT * FROM coding_environments
			 WHERE user_id = ? AND id != ? AND remote_environment_id = ?
			 ORDER BY created_at, id`
		)
		.all(self.user_id, self.id, remoteEnvironmentId) as CodingEnvironmentRow[];
	const flag = db.prepare(
		`UPDATE coding_environments SET status = 'error', last_error = ? WHERE id = ?`
	);
	for (const other of others) {
		const selfIsNewer =
			self.created_at > other.created_at ||
			(self.created_at === other.created_at && self.id > other.id);
		const [newer, older] = selfIsNewer ? [self, other] : [other, self];
		flag.run(duplicateEnvironmentError(older.name), newer.id);
	}
}

function writeEnvironmentCheck(db: Db, id: string, result: EnvironmentCheckResult): void {
	const now = Date.now();
	db.prepare(
		`UPDATE coding_environments SET status = ?,
		   server_version = COALESCE(?, server_version),
		   environment_label = COALESCE(?, environment_label),
		   remote_environment_id = COALESCE(?, remote_environment_id),
		   last_error = ?, last_checked_at = ?,
		   last_synced_at = CASE WHEN ? THEN ? ELSE last_synced_at END
		 WHERE id = ?`
	).run(
		result.status,
		result.serverVersion ?? null,
		result.environmentLabel ?? null,
		result.remoteEnvironmentId ?? null,
		result.error ?? null,
		now,
		result.synced ? 1 : 0,
		now,
		id
	);
}

// ── usage ────────────────────────────────────────────────────────────────

/** Replaces an environment's stored extra resets with a fresh snapshot. */
export function replaceResetCredits(
	db: Db,
	environmentId: string,
	credits: Omit<CodingResetCredits, 'environmentId'>[]
): void {
	const insert = db.prepare(
		`INSERT OR REPLACE INTO coding_usage_reset_credits
		   (environment_id, account_id, available_count, next_expires_at, checked_at)
		 VALUES (?, ?, ?, ?, ?)`
	);
	db.transaction(() => {
		db.prepare('DELETE FROM coding_usage_reset_credits WHERE environment_id = ?').run(
			environmentId
		);
		for (const c of credits) {
			insert.run(environmentId, c.accountId, c.availableCount, c.nextExpiresAt, c.checkedAt);
		}
	})();
}

/** Extra resets of all of a user's environments. */
export function listResetCredits(db: Db, userId: string): CodingResetCredits[] {
	const rows = db
		.prepare(
			`SELECT c.* FROM coding_usage_reset_credits c
			 JOIN coding_environments e ON e.id = c.environment_id
			 WHERE e.user_id = ?`
		)
		.all(userId) as {
		environment_id: string;
		account_id: string;
		available_count: number;
		next_expires_at: number | null;
		checked_at: number;
	}[];
	return rows.map((r) => ({
		environmentId: r.environment_id,
		accountId: r.account_id,
		availableCount: r.available_count,
		nextExpiresAt: r.next_expires_at,
		checkedAt: r.checked_at
	}));
}

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

/** How long plan-limit samples are kept: the longest preset range (90 days) plus slack. */
export const USAGE_LIMIT_SAMPLE_RETENTION_MS = 92 * 86_400_000;

/**
 * Appends one history sample per window (keyed by its `checkedAt`, so a repeated
 * snapshot is stored once) and prunes the environment's samples past retention.
 */
export function recordUsageLimitSamples(
	db: Db,
	environmentId: string,
	windows: Omit<CodingUsageLimitWindow, 'environmentId'>[],
	now = Date.now()
): void {
	const insert = db.prepare(
		`INSERT OR IGNORE INTO coding_usage_limit_samples
		   (environment_id, account_id, window_id, sampled_at, used_percent, resets_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	);
	db.transaction(() => {
		for (const w of windows) {
			insert.run(environmentId, w.accountId, w.windowId, w.checkedAt, w.usedPercent, w.resetsAt);
		}
		db.prepare(
			'DELETE FROM coding_usage_limit_samples WHERE environment_id = ? AND sampled_at < ?'
		).run(environmentId, now - USAGE_LIMIT_SAMPLE_RETENTION_MS);
	})();
}

/** Plan-limit samples of all of a user's environments in `[since, until]`, oldest first. */
export function listUsageLimitSamples(
	db: Db,
	userId: string,
	since: number,
	until = Number.MAX_SAFE_INTEGER
): CodingUsageLimitSample[] {
	const rows = db
		.prepare(
			`SELECT s.environment_id, s.account_id, s.window_id, s.sampled_at, s.used_percent, s.resets_at
			 FROM coding_usage_limit_samples s
			 JOIN coding_environments e ON e.id = s.environment_id
			 WHERE e.user_id = ? AND s.sampled_at >= ? AND s.sampled_at <= ?
			 ORDER BY s.sampled_at`
		)
		.all(userId, since, until) as {
		environment_id: string;
		account_id: string;
		window_id: string;
		sampled_at: number;
		used_percent: number;
		resets_at: number | null;
	}[];
	return rows.map((r) => ({
		environmentId: r.environment_id,
		accountId: r.account_id,
		windowId: r.window_id,
		sampledAt: r.sampled_at,
		usedPercent: r.used_percent,
		resetsAt: r.resets_at
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
