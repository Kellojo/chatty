import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';

export interface PromptCharBreakdown {
	system: number;
	skills: number;
	tools: number;
	messages: number;
}

export interface MessageUsage {
	providerId: string;
	modelId: string;
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
	latencyMs: number | null;
	costUsd: number | null;
	promptChars?: PromptCharBreakdown;
}

export interface MessageRow {
	rowid: number;
	id: string;
	conversation_id: string;
	role: string;
	parts: string;
	content_text: string;
	status: string;
	error: string | null;
	usage_json: string | null;
	created_at: number;
	/** The previous message on this message's path; NULL for a first message. */
	parent_id: string | null;
}

/** Where a message sits among its alternative versions (only set when it has some). */
export interface MessageBranch {
	/** 0-based position among the versions, oldest first. */
	index: number;
	count: number;
	/** Every version's id, oldest first. */
	ids: string[];
}

export interface ChatMessage {
	id: string;
	conversationId: string;
	role: 'user' | 'assistant' | 'system';
	parts: unknown[];
	status: 'complete' | 'partial' | 'failed';
	error: string | null;
	usage: MessageUsage | null;
	createdAt: number;
	/** Set when the message has alternative versions (edits or regenerated replies). */
	branch?: MessageBranch;
}

export function toPublic(row: MessageRow): ChatMessage {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		role: row.role as ChatMessage['role'],
		parts: JSON.parse(row.parts) as unknown[],
		status: row.status as ChatMessage['status'],
		error: row.error,
		usage: row.usage_json ? (JSON.parse(row.usage_json) as MessageUsage) : null,
		createdAt: row.created_at
	};
}

export function extractText(parts: unknown[]): string {
	return parts
		.filter(
			(p): p is { type: 'text'; text: string } =>
				typeof p === 'object' && p !== null && (p as { type?: string }).type === 'text'
		)
		.map((p) => p.text)
		.join('\n');
}

// ── message tree ─────────────────────────────────────────────────────────────
// Messages form a tree: `parent_id` is the previous message on a message's path
// (NULL for the first one), and messages sharing a parent are alternative
// versions of each other (an edit or a regenerated reply). The conversation's
// `active_leaf_id` picks the branch that is shown and sent to the model: the
// active path is the walk from that leaf up to the root, in creation order.

interface PathRef {
	id: string;
	created_at: number;
	rowid: number;
}

const PATH_CTE = `WITH RECURSIVE path(id) AS (
	SELECT ?
	UNION
	SELECT m.parent_id FROM path p CROSS JOIN messages m ON m.id = p.id
	WHERE m.parent_id IS NOT NULL AND +m.conversation_id = ?
)`;

/**
 * The newest leaf in the subtree of `messageId` (the message itself when it has
 * no replies). Undefined when it is not a message of that conversation.
 */
export function newestLeafUnder(
	db: Db,
	conversationId: string,
	messageId: string
): string | undefined {
	const row = db
		.prepare(
			`WITH RECURSIVE sub(id) AS (
				SELECT id FROM messages WHERE id = ? AND +conversation_id = ?
				UNION
				SELECT m.id FROM sub s CROSS JOIN messages m ON m.parent_id = s.id
				WHERE +m.conversation_id = ?
			)
			SELECT m.id FROM sub CROSS JOIN messages m INDEXED BY idx_messages_tree ON m.id = sub.id
			WHERE NOT EXISTS (
				SELECT 1 FROM messages c WHERE c.parent_id = m.id AND +c.conversation_id = ?
			)
			ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`
		)
		.get(messageId, conversationId, conversationId, conversationId) as { id: string } | undefined;
	return row?.id;
}

/**
 * The leaf of the branch the conversation shows. A pointer that is unset or
 * dangling falls back to the newest message, and a pointer that has gained
 * replies (e.g. its newer sibling was removed) follows them to their newest leaf.
 */
export function activeLeafId(db: Db, conversationId: string): string | undefined {
	const pointer = (
		db.prepare('SELECT active_leaf_id FROM conversations WHERE id = ?').get(conversationId) as
			{ active_leaf_id: string | null } | undefined
	)?.active_leaf_id;
	const leaf = pointer ? newestLeafUnder(db, conversationId, pointer) : undefined;
	if (leaf) return leaf;
	const newest = db
		.prepare(
			`SELECT id FROM messages WHERE conversation_id = ?
			 ORDER BY created_at DESC, rowid DESC LIMIT 1`
		)
		.get(conversationId) as { id: string } | undefined;
	return newest ? newestLeafUnder(db, conversationId, newest.id) : undefined;
}

function setActiveLeaf(db: Db, conversationId: string, leafId: string): void {
	db.prepare('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run(
		leafId,
		conversationId
	);
}

/**
 * Shows the branch through `messageId`: its newest leaf becomes the active one.
 * Returns that leaf, or undefined when the message is not in the conversation.
 */
export function activateBranch(
	db: Db,
	conversationId: string,
	messageId: string
): string | undefined {
	const leaf = newestLeafUnder(db, conversationId, messageId);
	if (leaf) setActiveLeaf(db, conversationId, leaf);
	return leaf;
}

/** Ids (plus ordering keys) of the active path, oldest to newest. Light: no parts are read. */
function activePathRefs(db: Db, conversationId: string): PathRef[] {
	const leaf = activeLeafId(db, conversationId);
	if (!leaf) return [];
	return db
		.prepare(
			`${PATH_CTE}
			 SELECT m.id, m.created_at, m.rowid AS rowid FROM path CROSS JOIN messages m INDEXED BY idx_messages_tree ON m.id = path.id
			 WHERE +m.conversation_id = ? ORDER BY m.created_at, m.rowid`
		)
		.all(leaf, conversationId, conversationId) as PathRef[];
}

const ID_CHUNK = 500;

/** Full rows for path refs, in the refs' order. */
function rowsFor(db: Db, refs: PathRef[]): MessageRow[] {
	if (refs.length === 0) return [];
	const byId = new Map<string, MessageRow>();
	for (let i = 0; i < refs.length; i += ID_CHUNK) {
		const ids = refs.slice(i, i + ID_CHUNK).map((r) => r.id);
		const rows = db
			.prepare(`SELECT rowid, * FROM messages WHERE id IN (${ids.map(() => '?').join(', ')})`)
			.all(...ids) as MessageRow[];
		for (const row of rows) byId.set(row.id, row);
	}
	return refs.flatMap((r) => byId.get(r.id) ?? []);
}

/** The conversation's active path (see above), oldest to newest. */
export function listMessages(db: Db, conversationId: string): MessageRow[] {
	const leaf = activeLeafId(db, conversationId);
	if (!leaf) return [];
	return db
		.prepare(
			`${PATH_CTE}
			 SELECT m.rowid, m.* FROM path CROSS JOIN messages m ON m.id = path.id
			 WHERE +m.conversation_id = ? ORDER BY m.created_at, m.rowid`
		)
		.all(leaf, conversationId, conversationId) as MessageRow[];
}

/**
 * Lists the active path from `messageId` (inclusive) onwards, in the same order
 * as `listMessages`. Returns undefined when the anchor is not on the active
 * path, so callers can fall back to a full list.
 */
export function listMessagesFrom(
	db: Db,
	conversationId: string,
	messageId: string
): MessageRow[] | undefined {
	const refs = activePathRefs(db, conversationId);
	const index = refs.findIndex((r) => r.id === messageId);
	if (index === -1) return undefined;
	return rowsFor(db, refs.slice(index));
}

/**
 * Lists the active path after `messageId` (exclusive), in `listMessages` order.
 * Undefined when the anchor is not on the active path.
 */
export function listMessagesAfter(
	db: Db,
	conversationId: string,
	messageId: string
): MessageRow[] | undefined {
	const refs = activePathRefs(db, conversationId);
	const index = refs.findIndex((r) => r.id === messageId);
	if (index === -1) return undefined;
	return rowsFor(db, refs.slice(index + 1));
}

/**
 * The active path split after the first of `anchorIds` that lies on it: that
 * anchor and the rows after it. Without one on the path, the whole path is
 * returned. Only the returned rows are read in full.
 */
export function listMessagesAfterFirstOnPath(
	db: Db,
	conversationId: string,
	anchorIds: string[]
): { anchorId: string | undefined; rows: MessageRow[] } {
	const refs = activePathRefs(db, conversationId);
	const position = new Map(refs.map((r, i) => [r.id, i]));
	for (const id of anchorIds) {
		const index = position.get(id);
		if (index !== undefined) return { anchorId: id, rows: rowsFor(db, refs.slice(index + 1)) };
	}
	return { anchorId: undefined, rows: rowsFor(db, refs) };
}

export const MESSAGE_PAGE_SIZE = 60;
export const MAX_MESSAGE_PAGE_SIZE = 200;

export interface MessagePage {
	/** Oldest to newest, like `listMessages`. */
	rows: MessageRow[];
	/** Whether messages older than the first row exist. */
	hasOlder: boolean;
}

/**
 * The newest `limit` messages of the active path, or the newest `limit` before
 * the message `before`. Undefined when `before` is not on the active path.
 */
export function listMessagesPage(
	db: Db,
	conversationId: string,
	options: { before?: string | null; limit?: number } = {}
): MessagePage | undefined {
	const limit = Math.min(
		MAX_MESSAGE_PAGE_SIZE,
		Math.max(1, Math.floor(options.limit ?? MESSAGE_PAGE_SIZE))
	);
	const refs = activePathRefs(db, conversationId);
	let end = refs.length;
	if (options.before) {
		end = refs.findIndex((r) => r.id === options.before);
		if (end === -1) return undefined;
	}
	const start = Math.max(0, end - limit);
	return { rows: rowsFor(db, refs.slice(start, end)), hasOlder: start > 0 };
}

/** The versions of each given message that has siblings, keyed by message id. */
export function branchesFor(
	db: Db,
	conversationId: string,
	rows: Pick<MessageRow, 'id'>[]
): Map<string, MessageBranch> {
	const result = new Map<string, MessageBranch>();
	if (rows.length === 0) return result;
	const ids = rows.map((r) => r.id);
	const parents = new Map<string, string | null>();
	for (let i = 0; i < ids.length; i += ID_CHUNK) {
		const chunk = ids.slice(i, i + ID_CHUNK);
		const found = db
			.prepare(
				`SELECT id, parent_id FROM messages
				 WHERE +conversation_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`
			)
			.all(conversationId, ...chunk) as { id: string; parent_id: string | null }[];
		for (const row of found) parents.set(row.id, row.parent_id);
	}
	const childrenOf = db.prepare(
		`SELECT id FROM messages WHERE parent_id = ? AND +conversation_id = ?
		 ORDER BY created_at, rowid`
	);
	const rootsOf = db.prepare(
		`SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS NULL
		 ORDER BY created_at, rowid`
	);
	const groups = new Map<string | null, string[]>();
	for (const id of ids) {
		if (!parents.has(id)) continue;
		const parent = parents.get(id)!;
		let group = groups.get(parent);
		if (!group) {
			const siblings = (
				parent === null ? rootsOf.all(conversationId) : childrenOf.all(parent, conversationId)
			) as { id: string }[];
			group = siblings.map((r) => r.id);
			groups.set(parent, group);
		}
		if (group.length > 1) {
			result.set(id, { index: group.indexOf(id), count: group.length, ids: group });
		}
	}
	return result;
}

/** `toPublic` for rows of one conversation, with their branch info attached. */
export function toPublicWithBranches(
	db: Db,
	conversationId: string,
	rows: MessageRow[]
): ChatMessage[] {
	const branches = branchesFor(db, conversationId, rows);
	return rows.map((row) => {
		const message = toPublic(row);
		const branch = branches.get(row.id);
		return branch ? { ...message, branch } : message;
	});
}

export function countMessages(db: Db, conversationId: string): number {
	const row = db
		.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?')
		.get(conversationId) as { count: number };
	return row.count;
}

export function getMessage(db: Db, id: string): MessageRow | undefined {
	return db.prepare('SELECT rowid, * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
}

export interface CreateMessageInput {
	id?: string;
	conversationId: string;
	role: 'user' | 'assistant' | 'system';
	parts: unknown[];
	status?: 'complete' | 'partial' | 'failed';
	error?: string | null;
	usage?: MessageUsage | null;
	createdAt?: number;
	/**
	 * The message this one follows. Omitted, it continues the active branch;
	 * an earlier message starts a new branch from there (null: a new first
	 * message). Either way the new message becomes the active leaf.
	 */
	parentId?: string | null;
}

export function createMessage(db: Db, input: CreateMessageInput): MessageRow {
	const id = input.id ?? randomUUID();
	return db.transaction(() => {
		const parentId =
			input.parentId !== undefined
				? input.parentId
				: (activeLeafId(db, input.conversationId) ?? null);
		db.prepare(
			`INSERT INTO messages (id, conversation_id, role, parts, content_text, status, error, usage_json, created_at, parent_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			id,
			input.conversationId,
			input.role,
			JSON.stringify(input.parts),
			extractText(input.parts),
			input.status ?? 'complete',
			input.error ?? null,
			input.usage ? JSON.stringify(input.usage) : null,
			input.createdAt ?? Date.now(),
			parentId
		);
		setActiveLeaf(db, input.conversationId, id);
		return getMessage(db, id)!;
	})();
}

export function updateMessage(
	db: Db,
	id: string,
	patch: {
		parts?: unknown[];
		status?: 'complete' | 'partial' | 'failed';
		error?: string | null;
		usage?: MessageUsage | null;
	}
): MessageRow | undefined {
	const existing = getMessage(db, id);
	if (!existing) return undefined;
	const parts = patch.parts !== undefined ? JSON.stringify(patch.parts) : existing.parts;
	const status = patch.status ?? existing.status;
	const error = patch.error !== undefined ? patch.error : existing.error;
	const usage =
		patch.usage !== undefined
			? patch.usage
				? JSON.stringify(patch.usage)
				: null
			: existing.usage_json;
	// Writing content_text re-indexes the row in FTS (see the messages_fts_update
	// trigger), so a message still being streamed only updates its parts; the
	// text is written once it settles, and only when it actually changed.
	const text =
		status === 'partial'
			? existing.content_text
			: extractText(patch.parts ?? (JSON.parse(existing.parts) as unknown[]));
	if (text !== existing.content_text) {
		db.prepare(
			'UPDATE messages SET parts = ?, content_text = ?, status = ?, error = ?, usage_json = ? WHERE id = ?'
		).run(parts, text, status, error, usage, id);
	} else {
		db.prepare(
			'UPDATE messages SET parts = ?, status = ?, error = ?, usage_json = ? WHERE id = ?'
		).run(parts, status, error, usage, id);
	}
	return getMessage(db, id);
}

/**
 * Settles responses whose generation died with the previous process. Call at
 * startup only, while nothing can be streaming. Responses that never produced
 * any output are removed, as they are when a live stream ends empty.
 */
export function finalizeInterruptedMessages(db: Db): number {
	return db.transaction(() => {
		const removed = db
			.prepare("DELETE FROM messages WHERE status = 'partial' AND parts = '[]'")
			.run().changes;
		// Partial rows never had their text indexed, so settle it along with them.
		const rows = db
			.prepare("SELECT id, parts, content_text FROM messages WHERE status = 'partial'")
			.all() as Pick<MessageRow, 'id' | 'parts' | 'content_text'>[];
		const settle = db.prepare(
			"UPDATE messages SET status = 'failed', error = 'Interrupted before completion' WHERE id = ?"
		);
		const settleWithText = db.prepare(
			"UPDATE messages SET status = 'failed', error = 'Interrupted before completion', content_text = ? WHERE id = ?"
		);
		for (const row of rows) {
			const text = extractText(JSON.parse(row.parts) as unknown[]);
			if (text === row.content_text) settle.run(row.id);
			else settleWithText.run(text, row.id);
		}
		return removed + rows.length;
	})();
}

/**
 * Deletes one message. Its replies move up to its parent and an active leaf on
 * it moves back to the parent (the messages_branch_delete trigger), so the rest
 * of the tree stays connected.
 */
export function deleteMessage(db: Db, id: string): boolean {
	return db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes > 0;
}
