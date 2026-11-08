import { randomUUID } from 'node:crypto';
import {
	isCodingPullRequestState,
	type CodingConversationSummary,
	type CodingTaskStatus
} from '$lib/coding-environments.js';
import type { Db } from '../index.js';

export interface ConversationRow {
	id: string;
	user_id: string;
	kind: string;
	title: string;
	mode: string;
	provider_id: string | null;
	model_id: string | null;
	system_prompt: string | null;
	memory_enabled: number;
	max_steps: number | null;
	temperature: number | null;
	max_tokens: number | null;
	pinned: number;
	agent_id: string | null;
	last_read_at: number | null;
	settled_at: number | null;
	settled_reason: string | null;
	created_at: number;
	updated_at: number;
	deleted_at: number | null;
	/** Present only on queries that join `coding_conversations` (see SIDEBAR_SELECT). */
	coding_project_title?: string | null;
	coding_status?: string | null;
	coding_run_started_at?: number | null;
	coding_diff_insertions?: number | null;
	coding_diff_deletions?: number | null;
	coding_pr_url?: string | null;
	coding_pr_state?: string | null;
}

export interface Conversation {
	id: string;
	kind: 'chat' | 'agent-run' | 'research';
	title: string;
	mode: 'chat' | 'agent';
	providerId: string | null;
	modelId: string | null;
	systemPrompt: string | null;
	memoryEnabled: boolean;
	maxSteps: number | null;
	temperature: number | null;
	maxTokens: number | null;
	pinned: boolean;
	agentId: string | null;
	settledAt: number | null;
	settledReason: SettledReason | null;
	/** Set when the conversation is a coding task run on a T3 Code server. */
	coding: ConversationCodingSummary | null;
	createdAt: number;
	updatedAt: number;
}

export type ConversationCodingSummary = CodingConversationSummary;

export type SettledReason = 'manual' | 'auto';

export function toPublic(row: ConversationRow): Conversation {
	return {
		id: row.id,
		kind: row.kind as Conversation['kind'],
		title: row.title,
		mode: row.mode as Conversation['mode'],
		providerId: row.provider_id,
		modelId: row.model_id,
		systemPrompt: row.system_prompt,
		memoryEnabled: row.memory_enabled === 1,
		maxSteps: row.max_steps,
		temperature: row.temperature,
		maxTokens: row.max_tokens,
		pinned: row.pinned === 1,
		agentId: row.agent_id,
		settledAt: row.settled_at,
		settledReason: row.settled_reason as SettledReason | null,
		coding: row.coding_status
			? {
					projectTitle: row.coding_project_title ?? '',
					status: row.coding_status as CodingTaskStatus,
					runStartedAt: row.coding_run_started_at ?? null,
					diff:
						row.coding_diff_insertions == null || row.coding_diff_deletions == null
							? null
							: { insertions: row.coding_diff_insertions, deletions: row.coding_diff_deletions },
					pullRequest: row.coding_pr_url
						? {
								state: isCodingPullRequestState(row.coding_pr_state) ? row.coding_pr_state : null
							}
						: null
				}
			: null,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export const CONVERSATIONS_PAGE_SIZE = 50;

/** Conversation columns plus the coding-task summary the sidebar shows. */
const CODING_SUMMARY_COLUMNS = `cc.project_title AS coding_project_title, cc.status AS coding_status,
	cc.run_started_at AS coding_run_started_at, cc.diff_insertions AS coding_diff_insertions,
	cc.diff_deletions AS coding_diff_deletions, cc.pr_url AS coding_pr_url, cc.pr_state AS coding_pr_state`;

const SIDEBAR_SELECT = `SELECT c.*, ${CODING_SUMMARY_COLUMNS}
	FROM conversations c
	LEFT JOIN coding_conversations cc ON cc.conversation_id = c.id`;

export function listConversations(
	db: Db,
	userId: string,
	opts: { offset?: number; limit?: number } = {}
): ConversationRow[] {
	const limit = opts.limit ?? CONVERSATIONS_PAGE_SIZE;
	const offset = opts.offset ?? 0;
	return db
		.prepare(
			`${SIDEBAR_SELECT}
			 WHERE c.user_id = ? AND c.kind = 'chat' AND c.deleted_at IS NULL AND c.settled_at IS NULL
			 ORDER BY c.pinned DESC, c.updated_at DESC
			 LIMIT ? OFFSET ?`
		)
		.all(userId, limit, offset) as ConversationRow[];
}

export function listSettledConversations(
	db: Db,
	userId: string,
	opts: { offset?: number; limit?: number } = {}
): ConversationRow[] {
	const limit = opts.limit ?? CONVERSATIONS_PAGE_SIZE;
	const offset = opts.offset ?? 0;
	return db
		.prepare(
			`${SIDEBAR_SELECT}
			 WHERE c.user_id = ? AND c.kind = 'chat' AND c.deleted_at IS NULL AND c.settled_at IS NOT NULL
			 ORDER BY c.settled_at DESC, c.updated_at DESC
			 LIMIT ? OFFSET ?`
		)
		.all(userId, limit, offset) as ConversationRow[];
}

export function countSettledConversations(db: Db, userId: string): number {
	return (
		db
			.prepare(
				`SELECT COUNT(*) AS n FROM conversations
				 WHERE user_id = ? AND kind = 'chat' AND deleted_at IS NULL AND settled_at IS NOT NULL`
			)
			.get(userId) as { n: number }
	).n;
}

export function listConversationsSince(db: Db, userId: string, since: number): ConversationRow[] {
	return db
		.prepare(
			`${SIDEBAR_SELECT}
			 WHERE c.user_id = ? AND c.kind = 'chat' AND c.deleted_at IS NULL AND c.updated_at >= ?
			 ORDER BY c.updated_at DESC`
		)
		.all(userId, since) as ConversationRow[];
}

export function getConversation(db: Db, userId: string, id: string): ConversationRow | undefined {
	return db
		.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
		.get(id, userId) as ConversationRow | undefined;
}

export interface CreateConversationInput {
	providerId?: string | null;
	modelId?: string | null;
	mode?: 'chat' | 'agent';
	kind?: 'chat' | 'agent-run' | 'research';
	title?: string;
	agentId?: string | null;
}

export function createConversation(
	db: Db,
	userId: string,
	input: CreateConversationInput = {}
): ConversationRow {
	const id = randomUUID();
	const now = Date.now();
	db.prepare(
		`INSERT INTO conversations (id, user_id, kind, title, mode, provider_id, model_id, agent_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		userId,
		input.kind ?? 'chat',
		input.title ?? '',
		input.mode ?? 'agent',
		input.providerId ?? null,
		input.modelId ?? null,
		input.agentId ?? null,
		now,
		now
	);
	return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow;
}

export interface UpdateConversationInput {
	title?: string;
	mode?: 'chat' | 'agent';
	providerId?: string | null;
	modelId?: string | null;
	systemPrompt?: string | null;
	memoryEnabled?: boolean;
	maxSteps?: number | null;
	temperature?: number | null;
	maxTokens?: number | null;
	agentId?: string | null;
}

export function updateConversation(
	db: Db,
	userId: string,
	id: string,
	patch: UpdateConversationInput
): ConversationRow | undefined {
	const existing = getConversation(db, userId, id);
	if (!existing) return undefined;
	db.prepare(
		`UPDATE conversations SET title = ?, mode = ?, provider_id = ?, model_id = ?,
		 system_prompt = ?, memory_enabled = ?, max_steps = ?, temperature = ?, max_tokens = ?, agent_id = ?
		 WHERE id = ?`
	).run(
		patch.title ?? existing.title,
		patch.mode ?? existing.mode,
		patch.providerId !== undefined ? patch.providerId : existing.provider_id,
		patch.modelId !== undefined ? patch.modelId : existing.model_id,
		patch.systemPrompt !== undefined ? patch.systemPrompt : existing.system_prompt,
		patch.memoryEnabled !== undefined ? (patch.memoryEnabled ? 1 : 0) : existing.memory_enabled,
		patch.maxSteps !== undefined ? patch.maxSteps : existing.max_steps,
		patch.temperature !== undefined ? patch.temperature : existing.temperature,
		patch.maxTokens !== undefined ? patch.maxTokens : existing.max_tokens,
		patch.agentId !== undefined ? patch.agentId : existing.agent_id,
		id
	);
	return getConversation(db, userId, id);
}

export function touchConversation(db: Db, id: string): void {
	db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}

/** Sets the title without counting as activity, so a generated title doesn't reorder the sidebar. */
export function setConversationTitle(db: Db, id: string, title: string): void {
	db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
}

export function softDeleteConversation(db: Db, userId: string, id: string): boolean {
	return (
		db
			.prepare(
				'UPDATE conversations SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
			)
			.run(Date.now(), id, userId).changes > 0
	);
}

export function listSoftDeletedBefore(db: Db, cutoffMs: number): string[] {
	return (
		db
			.prepare('SELECT id FROM conversations WHERE deleted_at IS NOT NULL AND deleted_at < ?')
			.all(cutoffMs) as { id: string }[]
	).map((r) => r.id);
}

export function purgeConversation(db: Db, id: string): void {
	// Attachments linked to messages, plus any orphaned uploads still pointing at
	// this conversation's workspace (path prefix "<id>/").
	db.prepare(
		`DELETE FROM attachments
		 WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)
		    OR path LIKE ?`
	).run(id, `${id}/%`);
	db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
	db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

export function togglePin(db: Db, userId: string, id: string): ConversationRow | undefined {
	const existing = getConversation(db, userId, id);
	if (!existing) return undefined;
	db.prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(
		existing.pinned === 1 ? 0 : 1,
		id
	);
	return getConversation(db, userId, id);
}

export function setConversationPinned(db: Db, userId: string, id: string, pinned: boolean): void {
	db.prepare('UPDATE conversations SET pinned = ? WHERE id = ? AND user_id = ?').run(
		pinned ? 1 : 0,
		id,
		userId
	);
}

/** Hides a conversation from the default sidebar list. Settling also unpins. */
export function settleConversation(
	db: Db,
	userId: string,
	id: string,
	reason: SettledReason = 'manual'
): ConversationRow | undefined {
	db.prepare(
		`UPDATE conversations SET settled_at = ?, settled_reason = ?, pinned = 0
		 WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
	).run(Date.now(), reason, id, userId);
	return getConversation(db, userId, id);
}

/**
 * Brings a conversation back to the active list. Counts as a look so that it
 * isn't immediately auto-settled again.
 */
export function unsettleConversation(
	db: Db,
	userId: string,
	id: string
): ConversationRow | undefined {
	db.prepare(
		`UPDATE conversations SET settled_at = NULL, settled_reason = NULL, last_read_at = ?
		 WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
	).run(Date.now(), id, userId);
	return getConversation(db, userId, id);
}

/**
 * Settles non-pinned chats nobody has looked at since `cutoffMs` (last look =
 * latest of read, update and creation time). Returns the settled ids per user.
 */
export function autoSettleConversations(
	db: Db,
	opts: { cutoffMs: number; excludeIds?: Iterable<string>; now?: number }
): Map<string, string[]> {
	const exclude = new Set(opts.excludeIds ?? []);
	const candidates = db
		.prepare(
			`SELECT id, user_id FROM conversations
			 WHERE kind = 'chat' AND deleted_at IS NULL AND settled_at IS NULL AND pinned = 0
			   AND MAX(COALESCE(last_read_at, 0), updated_at, created_at) < ?`
		)
		.all(opts.cutoffMs) as { id: string; user_id: string }[];
	const settle = db.prepare(
		`UPDATE conversations SET settled_at = ?, settled_reason = 'auto'
		 WHERE id = ? AND settled_at IS NULL`
	);
	const now = opts.now ?? Date.now();
	const byUser = new Map<string, string[]>();
	db.transaction(() => {
		for (const c of candidates) {
			if (exclude.has(c.id)) continue;
			if (settle.run(now, c.id).changes === 0) continue;
			const ids = byUser.get(c.user_id) ?? [];
			ids.push(c.id);
			byUser.set(c.user_id, ids);
		}
	})();
	return byUser;
}

export function markConversationRead(db: Db, userId: string, id: string): void {
	db.prepare('UPDATE conversations SET last_read_at = ? WHERE id = ? AND user_id = ?').run(
		Date.now(),
		id,
		userId
	);
}

/** Sets when the user last looked at the conversation (may move it backwards, i.e. mark unread). */
export function setConversationReadAt(db: Db, userId: string, id: string, readAt: number): void {
	db.prepare('UPDATE conversations SET last_read_at = ? WHERE id = ? AND user_id = ?').run(
		readAt,
		id,
		userId
	);
}

/** Creation time of the conversation's newest assistant message, or null if there is none. */
export function latestAssistantMessageAt(db: Db, id: string): number | null {
	const row = db
		.prepare(
			`SELECT MAX(created_at) AS at FROM messages WHERE conversation_id = ? AND role = 'assistant'`
		)
		.get(id) as { at: number | null } | undefined;
	return row?.at ?? null;
}

export function listUnreadChatIds(db: Db, userId: string): string[] {
	return (
		db
			.prepare(
				`SELECT c.id FROM conversations c
				 WHERE c.user_id = ? AND c.kind = 'chat' AND c.deleted_at IS NULL
				   AND EXISTS (
				     SELECT 1 FROM messages m
				     WHERE m.conversation_id = c.id AND m.role = 'assistant'
				       AND m.created_at > COALESCE(c.last_read_at, 0)
				   )`
			)
			.all(userId) as { id: string }[]
	).map((row) => row.id);
}

export const SEARCH_PAGE_SIZE = 50;
export const MAX_SEARCH_PAGE_SIZE = 200;

/** Escapes LIKE wildcards so user input matches literally (pair with `ESCAPE '!'`). */
export function escapeLike(value: string): string {
	return value.replace(/[!%_]/g, (ch) => `!${ch}`);
}

/**
 * Builds an FTS5 query that can't be a syntax error: only the word characters
 * the unicode61 tokenizer indexes are kept, each term is quoted (so operators
 * like AND/NEAR/column filters are plain words) and prefix-matched, and all
 * terms must match. Null when nothing searchable is left.
 */
export function toFtsQuery(query: string): string | null {
	const terms = query.match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [];
	if (terms.length === 0) return null;
	return terms.map((term) => `"${term}"*`).join(' AND ');
}

export function searchConversations(
	db: Db,
	userId: string,
	query: string,
	options: { limit?: number; offset?: number } = {}
): ConversationRow[] {
	const trimmed = query.trim();
	if (!trimmed) return [];
	const limit = Math.min(
		MAX_SEARCH_PAGE_SIZE,
		Math.max(1, Math.floor(options.limit ?? SEARCH_PAGE_SIZE))
	);
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const like = `%${escapeLike(trimmed)}%`;
	const ftsQuery = toFtsQuery(trimmed);
	// The FTS lookup runs once as an uncorrelated subquery (one index probe per
	// term) instead of being re-evaluated per conversation inside a join.
	const ftsClause = ftsQuery
		? 'OR c.id IN (SELECT conversation_id FROM messages_fts WHERE messages_fts MATCH ?)'
		: '';
	const params: unknown[] = [userId, like, like];
	if (ftsQuery) params.push(ftsQuery);
	params.push(limit, offset);
	return db
		.prepare(
			`SELECT c.*, ${CODING_SUMMARY_COLUMNS}
			 FROM conversations c
			 LEFT JOIN coding_conversations cc ON cc.conversation_id = c.id
			 WHERE c.user_id = ? AND c.kind = 'chat' AND c.deleted_at IS NULL
			   AND (c.title LIKE ? ESCAPE '!' OR cc.project_title LIKE ? ESCAPE '!' ${ftsClause})
			 ORDER BY c.pinned DESC, c.updated_at DESC
			 LIMIT ? OFFSET ?`
		)
		.all(...params) as ConversationRow[];
}

export function countConversations(db: Db): number {
	return (
		db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE deleted_at IS NULL').get() as {
			n: number;
		}
	).n;
}

export interface ConversationDailyCount {
	date: string;
	count: number;
}

export function conversationDailyCounts(db: Db, days: number): ConversationDailyCount[] {
	const from = Date.now() - days * 86400000;
	return db
		.prepare(
			`SELECT date(created_at / 1000, 'unixepoch') AS date,
			        COUNT(*) AS count
			 FROM conversations
			 WHERE deleted_at IS NULL AND created_at >= ?
			 GROUP BY date ORDER BY date`
		)
		.all(from) as ConversationDailyCount[];
}
