import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';

export interface AttachmentRow {
	id: string;
	message_id: string | null;
	kind: string;
	path: string;
	mime: string;
	sha256: string;
}

export function createAttachment(
	db: Db,
	input: { kind: string; path: string; mime: string; sha256: string }
): AttachmentRow {
	const id = randomUUID();
	db.prepare(
		'INSERT INTO attachments (id, message_id, kind, path, mime, sha256) VALUES (?, NULL, ?, ?, ?, ?)'
	).run(id, input.kind, input.path, input.mime, input.sha256);
	return getAttachment(db, id)!;
}

export function getAttachment(db: Db, id: string): AttachmentRow | undefined {
	return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
}

/**
 * Looks up an attachment by id, but only if it is stored under the given
 * conversation. Use this for any id that comes from a client or a model.
 */
export function getConversationAttachment(
	db: Db,
	conversationId: string,
	id: string
): AttachmentRow | undefined {
	const row = getAttachment(db, id);
	if (!row) return undefined;
	return row.path.replace(/\\/g, '/').startsWith(`${conversationId}/attachments/`)
		? row
		: undefined;
}

export function linkAttachmentsToMessage(db: Db, messageId: string, ids: string[]): void {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => '?').join(', ');
	db.prepare(
		`UPDATE attachments SET message_id = ? WHERE id IN (${placeholders}) AND message_id IS NULL`
	).run(messageId, ...ids);
}

export function listAttachmentsByConversation(db: Db, conversationId: string): AttachmentRow[] {
	return db
		.prepare(
			`SELECT a.* FROM attachments a
			 JOIN messages m ON m.id = a.message_id
			 WHERE m.conversation_id = ?`
		)
		.all(conversationId) as AttachmentRow[];
}

/** Stored paths of every attachment row, `/`-separated (rows written on Windows use `\`). */
export function listAttachmentPaths(db: Db): Set<string> {
	return new Set(
		(db.prepare('SELECT path FROM attachments').all() as { path: string }[]).map((r) =>
			r.path.replace(/\\/g, '/')
		)
	);
}

/**
 * Attachments never linked to a message (uploads that were never sent) in chat
 * conversations, or whose conversation is gone. Agent-run conversations are
 * left out: images their tools generate are referenced by id but never linked.
 */
export function listUnlinkedChatAttachments(db: Db): AttachmentRow[] {
	const rows = db
		.prepare('SELECT * FROM attachments WHERE message_id IS NULL')
		.all() as AttachmentRow[];
	const kindOf = db.prepare('SELECT kind FROM conversations WHERE id = ?');
	return rows.filter((row) => {
		const conversationId = row.path.replace(/\\/g, '/').split('/')[0];
		const conversation = kindOf.get(conversationId) as { kind: string } | undefined;
		return !conversation || conversation.kind === 'chat';
	});
}

/** Deletes an attachment only while it is still unlinked (it may have been sent meanwhile). */
export function deleteUnlinkedAttachment(db: Db, id: string): boolean {
	return (
		db.prepare('DELETE FROM attachments WHERE id = ? AND message_id IS NULL').run(id).changes > 0
	);
}
