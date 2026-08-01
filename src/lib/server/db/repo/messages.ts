import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';

export interface MessageUsage {
	providerId: string;
	modelId: string;
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
	latencyMs: number | null;
	costUsd: number | null;
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

export function listMessages(db: Db, conversationId: string): MessageRow[] {
	return db
		.prepare('SELECT rowid, * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid')
		.all(conversationId) as MessageRow[];
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
}

export function createMessage(db: Db, input: CreateMessageInput): MessageRow {
	const id = input.id ?? randomUUID();
	db.prepare(
		`INSERT INTO messages (id, conversation_id, role, parts, content_text, status, error, usage_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		input.conversationId,
		input.role,
		JSON.stringify(input.parts),
		extractText(input.parts),
		input.status ?? 'complete',
		input.error ?? null,
		input.usage ? JSON.stringify(input.usage) : null,
		input.createdAt ?? Date.now()
	);
	return getMessage(db, id)!;
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
	db.prepare(
		'UPDATE messages SET parts = ?, content_text = ?, status = ?, error = ?, usage_json = ? WHERE id = ?'
	).run(
		parts,
		patch.parts !== undefined ? extractText(patch.parts) : existing.content_text,
		patch.status ?? existing.status,
		patch.error !== undefined ? patch.error : existing.error,
		patch.usage !== undefined
			? patch.usage
				? JSON.stringify(patch.usage)
				: null
			: existing.usage_json,
		id
	);
	return getMessage(db, id);
}

export function deleteMessage(db: Db, id: string): boolean {
	return db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes > 0;
}

export function deleteMessagesFrom(db: Db, conversationId: string, messageId: string): number {
	const ref = getMessage(db, messageId);
	if (!ref || ref.conversation_id !== conversationId) return 0;
	const anchor = db.prepare('SELECT rowid AS rowid FROM messages WHERE id = ?').get(messageId) as {
		rowid: number;
	};
	return db
		.prepare(
			`DELETE FROM messages WHERE conversation_id = ?
			 AND (created_at > ? OR (created_at = ? AND rowid >= ?))`
		)
		.run(conversationId, ref.created_at, ref.created_at, anchor.rowid).changes;
}
