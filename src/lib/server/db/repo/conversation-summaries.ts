import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';
import { listMessages, listMessagesAfterFirstOnPath, type MessageRow } from './messages.js';

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

/**
 * The conversation's summaries, newest first. Only one whose anchor is on the
 * history at hand applies to it: a summary made on another branch (or whose
 * anchor is gone) describes a different history.
 */
function summariesNewestFirst(db: Db, conversationId: string): ConversationSummaryRow[] {
	return db
		.prepare(
			`SELECT * FROM conversation_summaries
			 WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC`
		)
		.all(conversationId) as ConversationSummaryRow[];
}

/**
 * Splits an ordered history (`listMessages` order) at the newest summary
 * anchored on it: the summary plus the messages after the one it was folded
 * through. Position, not rowid, decides what is covered, since SQLite reuses
 * the rowids of deleted messages. Summaries whose anchor is not in `rows` (gone,
 * or on another branch) are ignored.
 */
export function unsummarizedMessages<T extends { id: string }>(
	db: Db,
	conversationId: string,
	rows: T[]
): { summary: ConversationSummaryRow | undefined; rows: T[] } {
	const position = new Map(rows.map((r, i) => [r.id, i]));
	for (const summary of summariesNewestFirst(db, conversationId)) {
		const index = position.get(summary.through_message_id);
		if (index !== undefined) return { summary, rows: rows.slice(index + 1) };
	}
	return { summary: undefined, rows };
}

/**
 * Like `unsummarizedMessages` over the active path, but only the messages
 * after the summary's anchor are read in full.
 */
export function loadUnsummarizedMessages(
	db: Db,
	conversationId: string
): { summary: ConversationSummaryRow | undefined; rows: MessageRow[] } {
	const summaries = summariesNewestFirst(db, conversationId);
	if (summaries.length === 0) return { summary: undefined, rows: listMessages(db, conversationId) };
	const { anchorId, rows } = listMessagesAfterFirstOnPath(
		db,
		conversationId,
		summaries.map((s) => s.through_message_id)
	);
	return { summary: summaries.find((s) => s.through_message_id === anchorId), rows };
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
