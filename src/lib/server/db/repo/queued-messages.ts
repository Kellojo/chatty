import { randomUUID } from 'node:crypto';
import type { MessageQueueState, QueuedMessage } from '$lib/types.js';
import type { Db } from '../index.js';

export interface QueuedMessageRow {
	id: string;
	conversation_id: string;
	text: string;
	/** JSON array of file parts. */
	parts: string;
	position: number;
	created_at: number;
}

export function toPublic(row: QueuedMessageRow): QueuedMessage {
	return {
		id: row.id,
		text: row.text,
		files: JSON.parse(row.parts) as QueuedMessage['files'],
		createdAt: row.created_at
	};
}

export function listQueuedMessages(db: Db, conversationId: string): QueuedMessageRow[] {
	return db
		.prepare(
			`SELECT * FROM queued_messages WHERE conversation_id = ? ORDER BY position, created_at`
		)
		.all(conversationId) as QueuedMessageRow[];
}

export function getQueuedMessage(
	db: Db,
	conversationId: string,
	id: string
): QueuedMessageRow | undefined {
	return db
		.prepare(`SELECT * FROM queued_messages WHERE conversation_id = ? AND id = ?`)
		.get(conversationId, id) as QueuedMessageRow | undefined;
}

export function isQueuePaused(db: Db, conversationId: string): boolean {
	const row = db
		.prepare(`SELECT queue_paused FROM conversations WHERE id = ?`)
		.get(conversationId) as { queue_paused: number } | undefined;
	return row?.queue_paused === 1;
}

export function setQueuePaused(db: Db, conversationId: string, paused: boolean): void {
	db.prepare(`UPDATE conversations SET queue_paused = ? WHERE id = ?`).run(
		paused ? 1 : 0,
		conversationId
	);
}

export function getMessageQueue(db: Db, conversationId: string): MessageQueueState {
	return {
		items: listQueuedMessages(db, conversationId).map(toPublic),
		paused: isQueuePaused(db, conversationId)
	};
}

/** Appends a message to the end of the queue. */
export function enqueueMessage(
	db: Db,
	conversationId: string,
	message: { text: string; files: QueuedMessage['files'] }
): QueuedMessageRow {
	const row: QueuedMessageRow = {
		id: randomUUID(),
		conversation_id: conversationId,
		text: message.text,
		parts: JSON.stringify(message.files),
		position: 0,
		created_at: Date.now()
	};
	db.transaction(() => {
		const last = db
			.prepare(`SELECT MAX(position) AS max FROM queued_messages WHERE conversation_id = ?`)
			.get(conversationId) as { max: number | null };
		row.position = (last.max ?? -1) + 1;
		db.prepare(
			`INSERT INTO queued_messages (id, conversation_id, text, parts, position, created_at)
			 VALUES (@id, @conversation_id, @text, @parts, @position, @created_at)`
		).run(row);
	})();
	return row;
}

/** Puts a message back at the front, e.g. after it failed to send. */
export function requeueFirst(db: Db, row: QueuedMessageRow): void {
	db.transaction(() => {
		const first = db
			.prepare(`SELECT MIN(position) AS min FROM queued_messages WHERE conversation_id = ?`)
			.get(row.conversation_id) as { min: number | null };
		db.prepare(
			`INSERT OR REPLACE INTO queued_messages (id, conversation_id, text, parts, position, created_at)
			 VALUES (@id, @conversation_id, @text, @parts, @position, @created_at)`
		).run({ ...row, position: (first.min ?? 1) - 1 });
	})();
}

/** Removes a message; returns it, or undefined when it was already gone (sent elsewhere). */
export function removeQueuedMessage(
	db: Db,
	conversationId: string,
	id: string
): QueuedMessageRow | undefined {
	const row = getQueuedMessage(db, conversationId, id);
	if (!row) return undefined;
	const { changes } = db
		.prepare(`DELETE FROM queued_messages WHERE conversation_id = ? AND id = ?`)
		.run(conversationId, id);
	return changes > 0 ? row : undefined;
}

/** Takes the first message off the queue, if any. */
export function takeFirstQueuedMessage(
	db: Db,
	conversationId: string
): QueuedMessageRow | undefined {
	return db.transaction(() => {
		const row = db
			.prepare(
				`SELECT * FROM queued_messages WHERE conversation_id = ? ORDER BY position, created_at LIMIT 1`
			)
			.get(conversationId) as QueuedMessageRow | undefined;
		if (row) db.prepare(`DELETE FROM queued_messages WHERE id = ?`).run(row.id);
		return row;
	})();
}

/** Conversations (not deleted) with messages waiting, with their owners. */
export function listQueuedConversations(db: Db): { conversationId: string; userId: string }[] {
	return db
		.prepare(
			`SELECT DISTINCT q.conversation_id AS conversationId, c.user_id AS userId
			 FROM queued_messages q JOIN conversations c ON c.id = q.conversation_id
			 WHERE c.deleted_at IS NULL`
		)
		.all() as { conversationId: string; userId: string }[];
}
