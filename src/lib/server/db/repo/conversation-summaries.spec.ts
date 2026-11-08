import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { openDatabase } = await import('../index.js');
const repo = await import('./conversation-summaries.js');
const { createConversation } = await import('./conversations.js');
const { activateBranch, createMessage, listMessages } = await import('./messages.js');

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

	function summarize(through: { id: string; rowid: number }, text = 's') {
		return repo.createSummary(db, {
			conversationId: convId,
			throughMessageId: through.id,
			throughRowid: through.rowid,
			summaryText: text,
			tokenEstimate: 5
		});
	}

	it('splits the history after the summary anchor', () => {
		const [m1, m2, m3] = [1, 2, 3].map((i) =>
			createMessage(db, { conversationId: convId, role: 'user', parts: [], createdAt: i })
		);
		summarize(m2);
		const split = repo.unsummarizedMessages(db, convId, listMessages(db, convId));
		expect(split.summary?.through_message_id).toBe(m2.id);
		expect(split.rows.map((r) => r.id)).toEqual([m3.id]);
		expect(m1.id).toBeTruthy();
	});

	it('loadUnsummarizedMessages reads only the rows after the anchor', () => {
		const ms = [1, 2, 3, 4].map((i) =>
			createMessage(db, { conversationId: convId, role: 'user', parts: [], createdAt: i })
		);
		expect(repo.loadUnsummarizedMessages(db, convId).rows).toHaveLength(4);
		summarize(ms[1]);
		const loaded = repo.loadUnsummarizedMessages(db, convId);
		expect(loaded.summary?.through_message_id).toBe(ms[1].id);
		expect(loaded.rows.map((r) => r.id)).toEqual([ms[2].id, ms[3].id]);
		db.prepare('DELETE FROM messages WHERE id = ?').run(ms[1].id);
		const orphaned = repo.loadUnsummarizedMessages(db, convId);
		expect(orphaned.summary).toBeUndefined();
		expect(orphaned.rows.map((r) => r.id)).toEqual([ms[0].id, ms[2].id, ms[3].id]);
	});

	it('ignores a summary whose anchor message is gone, even if its rowid was reused', () => {
		const m1 = createMessage(db, { conversationId: convId, role: 'user', parts: [] });
		const m2 = createMessage(db, { conversationId: convId, role: 'assistant', parts: [] });
		summarize(m2);
		db.prepare('DELETE FROM messages WHERE id = ?').run(m2.id);
		const reused = createMessage(db, { conversationId: convId, role: 'assistant', parts: [] });
		expect(reused.rowid).toBe(m2.rowid);
		const split = repo.unsummarizedMessages(db, convId, listMessages(db, convId));
		expect(split.summary).toBeUndefined();
		expect(split.rows.map((r) => r.id)).toEqual([m1.id, reused.id]);
	});

	it('uses only summaries anchored on the active branch', () => {
		const ms = [1, 2, 3, 4].map((i) =>
			createMessage(db, { conversationId: convId, role: 'user', parts: [], createdAt: i })
		);
		summarize(ms[0], 'old');
		summarize(ms[2], 'new');
		// An edit of ms[1] starts a branch that doesn't contain ms[2].
		const edit = createMessage(db, {
			conversationId: convId,
			role: 'user',
			parts: [],
			createdAt: 5,
			parentId: ms[0].id
		});
		const split = repo.unsummarizedMessages(db, convId, listMessages(db, convId));
		expect(split.summary?.summary_text).toBe('old');
		expect(split.rows.map((r) => r.id)).toEqual([edit.id]);
		const loaded = repo.loadUnsummarizedMessages(db, convId);
		expect(loaded.summary?.summary_text).toBe('old');
		expect(loaded.rows.map((r) => r.id)).toEqual([edit.id]);
		// Back on the original branch, its newer summary applies again.
		activateBranch(db, convId, ms[1].id);
		const original = repo.loadUnsummarizedMessages(db, convId);
		expect(original.summary?.summary_text).toBe('new');
		expect(original.rows.map((r) => r.id)).toEqual([ms[3].id]);
	});
});
