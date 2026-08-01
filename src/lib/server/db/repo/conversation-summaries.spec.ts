import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { openDatabase } = await import('../index.js');
const repo = await import('./conversation-summaries.js');
const { createConversation } = await import('./conversations.js');
const { createMessage } = await import('./messages.js');

describe('conversation-summaries repo', () => {
	let db: ReturnType<typeof openDatabase>;
	let convId: string;

	beforeEach(() => {
		db = openDatabase(':memory:');
		db.prepare(
			'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, 0, 0, ?)'
		).run('u1', 'A', 'a@b.c', 'admin');
		convId = createConversation(db, 'u1', { title: 't' }).id;
	});

	it('creates and fetches the latest summary', () => {
		const m1 = createMessage(db, { conversationId: convId, role: 'user', parts: [] });
		const m2 = createMessage(db, { conversationId: convId, role: 'assistant', parts: [] });
		repo.createSummary(db, {
			conversationId: convId,
			throughMessageId: m1.id,
			throughRowid: m1.rowid,
			summaryText: 'first',
			tokenEstimate: 10
		});
		repo.createSummary(db, {
			conversationId: convId,
			throughMessageId: m2.id,
			throughRowid: m2.rowid,
			summaryText: 'second',
			tokenEstimate: 20
		});
		const latest = repo.latestSummary(db, convId)!;
		expect(latest.summary_text).toBe('second');
		expect(latest.through_message_id).toBe(m2.id);
		expect(latest.through_rowid).toBe(m2.rowid);
	});

	it('returns undefined when no summary exists', () => {
		expect(repo.latestSummary(db, convId)).toBeUndefined();
	});

	it('scopes summaries to their conversation', () => {
		const other = createConversation(db, 'u1', { title: 'other' }).id;
		const m = createMessage(db, { conversationId: convId, role: 'user', parts: [] });
		repo.createSummary(db, {
			conversationId: convId,
			throughMessageId: m.id,
			throughRowid: m.rowid,
			summaryText: 's',
			tokenEstimate: 5
		});
		expect(repo.latestSummary(db, other)).toBeUndefined();
	});

	it('cascades on conversation purge', () => {
		const m = createMessage(db, { conversationId: convId, role: 'user', parts: [] });
		repo.createSummary(db, {
			conversationId: convId,
			throughMessageId: m.id,
			throughRowid: m.rowid,
			summaryText: 's',
			tokenEstimate: 5
		});
		db.prepare('DELETE FROM conversations WHERE id = ?').run(convId);
		expect(repo.latestSummary(db, convId)).toBeUndefined();
	});
});
