import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';

export interface ConversationSummaryRow {
	id: string;
	conversation_id: string;
	through_message_id: string;
	through_rowid: number;
	summary_text: string;
	token_estimate: number;
	created_at: number;
}

export function latestSummary(db: Db, conversationId: string): ConversationSummaryRow | undefined {
	return db
		.prepare(
			`SELECT * FROM conversation_summaries
			 WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
		)
		.get(conversationId) as ConversationSummaryRow | undefined;
}

export function createSummary(
	db: Db,
	input: {
		conversationId: string;
		throughMessageId: string;
		throughRowid: number;
		summaryText: string;
		tokenEstimate: number;
	}
): ConversationSummaryRow {
	const id = randomUUID();
	db.prepare(
		`INSERT INTO conversation_summaries
		 (id, conversation_id, through_message_id, through_rowid, summary_text, token_estimate, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		input.conversationId,
		input.throughMessageId,
		input.throughRowid,
		input.summaryText,
		input.tokenEstimate,
		Date.now()
	);
	return db.prepare('SELECT * FROM conversation_summaries WHERE id = ?').get(id) as
		ConversationSummaryRow | undefined as ConversationSummaryRow;
}

export function deleteSummary(db: Db, id: string): boolean {
	return db.prepare('DELETE FROM conversation_summaries WHERE id = ?').run(id).changes > 0;
}
