import { randomUUID } from 'node:crypto';
import {
	isCodingPullRequestState,
	type CodingConversationSummary,
	type CodingTaskStatus
} from '$lib/coding-environments.js';
import type { AgentRunStatus, ConversationOrigin } from '$lib/types.js';
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
	origin: string;
	last_read_at: number | null;
	settled_at: number | null;
	settled_reason: string | null;
	snoozed_at: number | null;
	snoozed_until: number | null;
	woke_at: number | null;
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
	/** Present only on queries that join the latest agent run (see SIDEBAR_SELECT). */
	agent_run_id?: string | null;
	agent_run_status?: string | null;
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
	origin: ConversationOrigin;
	agentRun: { id: string; status: AgentRunStatus } | null;
	settledAt: number | null;
	settledReason: SettledReason | null;
	/** Hidden from the active list until then (ms); null when not snoozed. */
	snoozedUntil: number | null;
	/** When a snooze last ended; the list sorts it like activity then. */
	wokeAt: number | null;
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
		origin: row.origin === 'dispatch' ? 'dispatch' : 'user',
		agentRun:
			row.agent_run_id && row.agent_run_status
				? { id: row.agent_run_id, status: row.agent_run_status as AgentRunStatus }
				: null,
		settledAt: row.settled_at,
		settledReason: row.settled_reason as SettledReason | null,
		snoozedUntil: row.snoozed_until,
		wokeAt: row.woke_at,
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

/** The conversation's latest agent run (sidebar "needs you" state, run links). */
const AGENT_RUN_COLUMNS = `(SELECT r.id FROM agent_runs r WHERE r.conversation_id = c.id
		ORDER BY r.started_at DESC LIMIT 1) AS agent_run_id,
	(SELECT r.status FROM agent_runs r WHERE r.conversation_id = c.id
		ORDER BY r.started_at DESC LIMIT 1) AS agent_run_status`;

const SIDEBAR_SELECT = `SELECT c.*, ${CODING_SUMMARY_COLUMNS}, ${AGENT_RUN_COLUMNS}
	FROM conversations c
	LEFT JOIN coding_conversations cc ON cc.conversation_id = c.id`;

/**
 * A snooze still hides the chat (bind `now`). A coding task that waits for an
 * answer shows anyway, as a pending question breaks through a snooze on T3.
 * Needs the `cc` join.
 */
const SNOOZED_WHERE = `(c.snoozed_until IS NOT NULL AND c.snoozed_until > ?
	AND (cc.status IS NULL OR cc.status != 'awaiting_input'))`;

/** Newest activity first, where a snooze ending counts as activity. */
const ACTIVITY_ORDER = `MAX(c.updated_at, COALESCE(c.woke_at, 0)) DESC`;

/** Active chats: neither settled nor snoozed. */
export function listConversations(
	db: Db,
	userId: string,
	opts: { offset?: number; limit?: number; now?: number } = {}
): ConversationRow[] {
	const limit = opts.limit ?? CONVERSATIONS_PAGE_SIZE;
	const offset = opts.offset ?? 0;
	return db
		.prepare(
			`${SIDEBAR_SELECT}
			 WHERE c.user_id = ? AND c.kind = 'chat' AND c.deleted_at IS NULL AND c.settled_at IS NULL
			   AND NOT ${SNOOZED_WHERE}
			 ORDER BY c.pinned DESC, ${ACTIVITY_ORDER}
			 LIMIT ? OFFSET ?`
		)
		.all(userId, opts.now ?? Date.now(), limit, offset) as ConversationRow[];
}

/** Chats a snooze still hides, the soonest to wake first. */
export function listSnoozedConversations(
	db: Db,
	userId: string,
	opts: { limit?: number; now?: number } = {}
): ConversationRow[] {
	return db
		.prepare(
			`${SIDEBAR_SELECT}
			 WHERE c.user_id = ? AND c.kind = 'chat' AND c.deleted_at IS NULL AND c.settled_at IS NULL
			   AND ${SNOOZED_WHERE}
			 ORDER BY c.snoozed_until ASC
			 LIMIT ?`
		)
		.all(userId, opts.now ?? Date.now(), opts.limit ?? 200) as ConversationRow[];
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

/**
 * Chats updated since `since`. `excludeDispatched` leaves out chats Chatty
 * started for agent runs: their content is the agent's, not the user's (memory
 * extraction lists recent chats this way).
 */
export function listConversationsSince(
	db: Db,
	userId: string,
	since: number,
	opts: { excludeDispatched?: boolean } = {}
): ConversationRow[] {
	const dispatched = opts.excludeDispatched ? `AND c.origin != 'dispatch'` : '';
	return db
		.prepare(
			`${SIDEBAR_SELECT}
			 WHERE c.user_id = ? AND c.kind = 'chat' AND c.deleted_at IS NULL AND c.updated_at >= ?
			   ${dispatched}
			 ORDER BY c.updated_at DESC`
		)
		.all(userId, since) as ConversationRow[];
}

/** One conversation with the coding-task and agent-run summary the sidebar shows. */
export function getSidebarConversation(
	db: Db,
	userId: string,
	id: string
): ConversationRow | undefined {
	return db
		.prepare(`${SIDEBAR_SELECT} WHERE c.id = ? AND c.user_id = ? AND c.deleted_at IS NULL`)
		.get(id, userId) as ConversationRow | undefined;
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
	/** Snapshot of an agent's prompt (dispatched runs); null uses the default prompt. */
	systemPrompt?: string | null;
	maxSteps?: number | null;
	origin?: ConversationOrigin;
}

export function createConversation(
	db: Db,
	userId: string,
	input: CreateConversationInput = {}
): ConversationRow {
	const id = randomUUID();
	const now = Date.now();
	db.prepare(
		`INSERT INTO conversations (id, user_id, kind, title, mode, provider_id, model_id, agent_id,
		 system_prompt, max_steps, origin, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		userId,
		input.kind ?? 'chat',
		input.title ?? '',
		input.mode ?? 'agent',
		input.providerId ?? null,
		input.modelId ?? null,
		input.agentId ?? null,
		input.systemPrompt ?? null,
		input.maxSteps ?? null,
		input.origin ?? 'user',
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
	setConversationPinned(db, userId, id, existing.pinned !== 1);
	return getConversation(db, userId, id);
}

/** Pinning ends a snooze: a pinned chat is one you keep in view. */
export function setConversationPinned(db: Db, userId: string, id: string, pinned: boolean): void {
	const unsnooze = pinned ? ', snoozed_at = NULL, snoozed_until = NULL' : '';
	db.prepare(`UPDATE conversations SET pinned = ?${unsnooze} WHERE id = ? AND user_id = ?`).run(
		pinned ? 1 : 0,
		id,
		userId
	);
}

/**
 * Hides a conversation from the active list until `until` (ms). Snoozing
 * unpins it (pinned chats stay in view); settled conversations can't be snoozed.
 */
export function snoozeConversation(
	db: Db,
	userId: string,
	id: string,
	until: number,
	now = Date.now()
): ConversationRow | undefined {
	db.prepare(
		`UPDATE conversations SET snoozed_at = ?, snoozed_until = ?, pinned = 0
		 WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND settled_at IS NULL`
	).run(now, until, id, userId);
	return getConversation(db, userId, id);
}

/**
 * Ends a conversation's snooze early. It comes back as if it had just woken,
 * so it sorts to the top. Returns whether it was snoozed.
 */
export function unsnoozeConversation(
	db: Db,
	userId: string,
	id: string,
	now = Date.now()
): boolean {
	return (
		db
			.prepare(
				`UPDATE conversations SET snoozed_at = NULL, snoozed_until = NULL, woke_at = ?
				 WHERE id = ? AND user_id = ? AND snoozed_until IS NOT NULL`
			)
			.run(now, id, userId).changes > 0
	);
}

/**
 * Ends every snooze that is due (at `now` or earlier), stamping `woke_at` with
 * the time it was due. Returns the woken ids per user.
 */
export function wakeDueSnoozes(db: Db, now = Date.now()): Map<string, string[]> {
	const due = db
		.prepare(
			`SELECT id, user_id, snoozed_until FROM conversations
			 WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?`
		)
		.all(now) as { id: string; user_id: string; snoozed_until: number }[];
	const wake = db.prepare(
		`UPDATE conversations SET snoozed_at = NULL, snoozed_until = NULL, woke_at = ?
		 WHERE id = ? AND snoozed_until = ?`
	);
	const byUser = new Map<string, string[]>();
	db.transaction(() => {
		for (const c of due) {
			if (wake.run(c.snoozed_until, c.id, c.snoozed_until).changes === 0) continue;
			byUser.set(c.user_id, [...(byUser.get(c.user_id) ?? []), c.id]);
		}
	})();
	return byUser;
}

/** Hides a conversation from the default sidebar list. Settling also unpins and unsnoozes. */
export function settleConversation(
	db: Db,
	userId: string,
	id: string,
	reason: SettledReason = 'manual'
): ConversationRow | undefined {
	db.prepare(
		`UPDATE conversations SET settled_at = ?, settled_reason = ?, pinned = 0,
		 snoozed_at = NULL, snoozed_until = NULL
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
 * Settles non-pinned, non-snoozed chats nobody has looked at since `cutoffMs`
 * (last look = latest of read, update, creation and wake time). Returns the
 * settled ids per user.
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
			   AND snoozed_until IS NULL
			   AND MAX(COALESCE(last_read_at, 0), updated_at, created_at, COALESCE(woke_at, 0)) < ?`
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
	const params: unknown[] = ftsQuery
		? [ftsQuery, userId, userId, like, like]
		: [userId, like, like];
	params.push(limit, offset);
	return db.prepare(searchConversationsSql(ftsQuery !== null)).all(...params) as ConversationRow[];
}

/**
 * The search statement. Message text counts only on the version a conversation
 * shows: FTS runs once (an uncorrelated lookup, one index probe per term), then
 * only the conversations it hit have their active path walked (from
 * `active_leaf_id` up `parent_id`), and a hit must lie on it. A conversation
 * without a leaf pointer keeps matching any of its messages.
 *
 * Parameters: with FTS `[ftsQuery, userId, userId, like, like, limit, offset]`,
 * without `[userId, like, like, limit, offset]`. Exported for query-plan tests.
 */
export function searchConversationsSql(withFts: boolean): string {
	const cte = withFts
		? `WITH RECURSIVE
			 hits(id, conversation_id) AS MATERIALIZED (
			   SELECT m.id, m.conversation_id FROM messages_fts f CROSS JOIN messages m ON m.rowid = f.rowid
			   WHERE messages_fts MATCH ?
			 ),
			 hit_conversations(id, leaf) AS MATERIALIZED (
			   SELECT hc.id, hc.active_leaf_id FROM conversations hc
			   WHERE hc.id IN (SELECT conversation_id FROM hits) AND hc.user_id = ?
			 ),
			 path(conversation_id, id) AS (
			   SELECT id, leaf FROM hit_conversations WHERE leaf IS NOT NULL
			   UNION
			   SELECT p.conversation_id, m.parent_id FROM path p CROSS JOIN messages m ON m.id = p.id
			   WHERE m.parent_id IS NOT NULL AND +m.conversation_id = p.conversation_id
			 ),
			 matched(conversation_id) AS MATERIALIZED (
			   SELECT h.conversation_id FROM hits h CROSS JOIN path p
			   WHERE p.conversation_id = h.conversation_id AND p.id = h.id
			   UNION
			   SELECT h.conversation_id FROM hits h CROSS JOIN hit_conversations hc
			   WHERE hc.id = h.conversation_id AND hc.leaf IS NULL
			 )
			 `
		: '';
	const ftsClause = withFts ? 'OR c.id IN (SELECT conversation_id FROM matched)' : '';
	// No run columns: they are correlated lookups, and search must stay one FTS
	// pass. Results then show without the agent run's "needs you" state.
	return `${cte}SELECT c.*, ${CODING_SUMMARY_COLUMNS}
		 FROM conversations c
		 LEFT JOIN coding_conversations cc ON cc.conversation_id = c.id
		 WHERE c.user_id = ? AND c.kind = 'chat' AND c.deleted_at IS NULL
		   AND (c.title LIKE ? ESCAPE '!' OR cc.project_title LIKE ? ESCAPE '!' ${ftsClause})
		 ORDER BY c.pinned DESC, ${ACTIVITY_ORDER}
		 LIMIT ? OFFSET ?`;
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
