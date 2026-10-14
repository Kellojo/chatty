import { randomUUID } from 'node:crypto';
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
	created_at: number;
	updated_at: number;
	deleted_at: number | null;
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
	createdAt: number;
	updatedAt: number;
}

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
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export const CONVERSATIONS_PAGE_SIZE = 50;

export function listConversations(
	db: Db,
	userId: string,
	opts: { offset?: number; limit?: number } = {}
): ConversationRow[] {
	const limit = opts.limit ?? CONVERSATIONS_PAGE_SIZE;
	const offset = opts.offset ?? 0;
	return db
		.prepare(
			`SELECT * FROM conversations
			 WHERE user_id = ? AND kind = 'chat' AND deleted_at IS NULL
			 ORDER BY pinned DESC, updated_at DESC
			 LIMIT ? OFFSET ?`
		)
		.all(userId, limit, offset) as ConversationRow[];
}

export function listConversationsSince(db: Db, userId: string, since: number): ConversationRow[] {
	return db
		.prepare(
			`SELECT * FROM conversations
			 WHERE user_id = ? AND kind = 'chat' AND deleted_at IS NULL AND updated_at >= ?
			 ORDER BY updated_at DESC`
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

export function setConversationTitle(db: Db, id: string, title: string): void {
	db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(
		title,
		Date.now(),
		id
	);
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

export function markConversationRead(db: Db, userId: string, id: string): void {
	db.prepare('UPDATE conversations SET last_read_at = ? WHERE id = ? AND user_id = ?').run(
		Date.now(),
		id,
		userId
	);
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

export function searchConversations(db: Db, userId: string, query: string): ConversationRow[] {
	const ftsQuery = query
		.split(/\s+/)
		.filter(Boolean)
		.map((term) => `"${term.replace(/"/g, '""')}"*`)
		.join(' AND ');
	if (!ftsQuery) return [];
	return db
		.prepare(
			`SELECT DISTINCT c.* FROM conversations c
			 LEFT JOIN messages_fts f ON f.conversation_id = c.id AND messages_fts MATCH ?
			 WHERE c.user_id = ? AND c.kind = 'chat' AND c.deleted_at IS NULL
			   AND (c.title LIKE ? OR f.conversation_id IS NOT NULL)
			 ORDER BY c.pinned DESC, c.updated_at DESC`
		)
		.all(ftsQuery, userId, `%${query}%`) as ConversationRow[];
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
