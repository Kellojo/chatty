import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../index.js';
import { createConversation } from './conversations.js';
import {
	activateBranch,
	activeLeafId,
	branchesFor,
	compareMessageParts,
	createMessage,
	deleteBranch,
	deleteMessage,
	extractText,
	finalizeInterruptedMessages,
	getMessage,
	getMessageMeta,
	insertMessageBefore,
	listMessages,
	listMessagesFrom,
	listMessagesAfter,
	listMessagesPage,
	listLatestMessages,
	MAX_PARTIAL_SAVE_INTERVAL_MS,
	partialSaveIntervalMs,
	reopenMessage,
	toPublic,
	toPublicWithBranches,
	updateMessage,
	updateMessageParts
} from './messages.js';

let db: Db;
let conversationId: string;

beforeEach(() => {
	db = openDatabase(':memory:');
	db.prepare(
		'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u1\', \'a@b.c\', \'A\', 0, 0, 0, \'user\')'
	).run();
	conversationId = createConversation(db, 'u1').id;
});

describe('finalizeInterruptedMessages', () => {
	it('fails partial messages with output and removes empty ones', () => {
		const done = createMessage(db, {
			conversationId,
			role: 'user',
			parts: [{ type: 'text', text: 'q' }]
		});
		const withOutput = createMessage(db, {
			conversationId,
			role: 'assistant',
			parts: [{ type: 'text', text: 'half an ans' }],
			status: 'partial'
		});
		createMessage(db, { conversationId, role: 'assistant', parts: [], status: 'partial' });

		expect(finalizeInterruptedMessages(db)).toBe(2);

		const rows = listMessages(db, conversationId);
		expect(rows.map((r) => r.id)).toEqual([done.id, withOutput.id]);
		expect(rows[0].status).toBe('complete');
		expect(rows[0].error).toBeNull();
		expect(rows[1].status).toBe('failed');
		expect(rows[1].error).toBe('Interrupted before completion');
		expect(rows[1].content_text).toBe('half an ans');
		expect(finalizeInterruptedMessages(db)).toBe(0);
	});

	it('indexes the text streamed into a partial message when settling it', () => {
		const m = createMessage(db, {
			conversationId,
			role: 'assistant',
			parts: [],
			status: 'partial'
		});
		updateMessage(db, m.id, { parts: [{ type: 'text', text: 'cut short' }] });
		expect(finalizeInterruptedMessages(db)).toBe(1);
		expect(listMessages(db, conversationId)[0].content_text).toBe('cut short');
	});
});

describe('messages repo', () => {
	it('createMessage extracts searchable text from parts', () => {
		const m = createMessage(db, {
			conversationId,
			role: 'user',
			parts: [
				{ type: 'text', text: 'hello' },
				{ type: 'file', url: 'x' },
				{ type: 'text', text: 'world' }
			]
		});
		expect(m.content_text).toBe('hello\nworld');
		expect(toPublic(m).parts).toHaveLength(3);
	});

	it('updateMessage patches parts, status, and error', () => {
		const m = createMessage(db, { conversationId, role: 'assistant', parts: [] });
		const updated = updateMessage(db, m.id, {
			parts: [{ type: 'text', text: 'partial answer' }],
			status: 'failed',
			error: 'aborted'
		});
		expect(updated!.status).toBe('failed');
		expect(updated!.error).toBe('aborted');
		expect(updated!.content_text).toBe('partial answer');
	});

	it('updateMessage leaves content_text and FTS alone while a message is partial', () => {
		const ftsMatches = (term: string) =>
			db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(term).length;
		const m = createMessage(db, {
			conversationId,
			role: 'assistant',
			parts: [],
			status: 'partial'
		});
		const streaming = updateMessage(db, m.id, {
			parts: [{ type: 'text', text: 'streamed answer' }]
		});
		expect(streaming!.parts).toContain('streamed answer');
		expect(streaming!.content_text).toBe('');
		expect(ftsMatches('streamed')).toBe(0);

		const done = updateMessage(db, m.id, { status: 'complete' });
		expect(done!.content_text).toBe('streamed answer');
		expect(ftsMatches('streamed')).toBe(1);
	});

	it('updateMessageParts saves a partial message in place, and nothing else', () => {
		const ftsMatches = (term: string) =>
			db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(term).length;
		const m = createMessage(db, {
			conversationId,
			role: 'assistant',
			parts: [],
			status: 'partial'
		});
		const parts = JSON.stringify([{ type: 'text', text: 'streamed answer' }]);
		expect(updateMessageParts(db, m.id, parts)).toBe(true);
		expect(getMessage(db, m.id)).toMatchObject({ parts, content_text: '', status: 'partial' });
		expect(ftsMatches('streamed')).toBe(0);

		updateMessage(db, m.id, { status: 'complete' });
		// Settled: its final parts win over a late snapshot.
		expect(updateMessageParts(db, m.id, '[]')).toBe(false);
		expect(getMessage(db, m.id)!.parts).toBe(parts);
		expect(updateMessageParts(db, 'nope', '[]')).toBe(false);
	});

	it('reopenMessage makes a settled message partial again, keeping its text', () => {
		const m = createMessage(db, {
			conversationId,
			role: 'assistant',
			parts: [{ type: 'text', text: 'so far' }],
			status: 'failed',
			error: 'boom'
		});
		expect(reopenMessage(db, m.id)).toBe(true);
		expect(getMessage(db, m.id)).toMatchObject({
			status: 'partial',
			error: null,
			content_text: 'so far'
		});
		expect(reopenMessage(db, 'nope')).toBe(false);
	});

	it('reads a message without its parts, or compares them in place', () => {
		const m = createMessage(db, {
			conversationId,
			role: 'assistant',
			parts: [{ type: 'text', text: 'hi' }],
			status: 'failed',
			error: 'boom',
			createdAt: 5
		});
		expect(getMessageMeta(db, m.id)).toEqual({
			id: m.id,
			conversation_id: conversationId,
			role: 'assistant',
			status: 'failed',
			error: 'boom',
			created_at: 5,
			parent_id: null
		});
		expect(getMessageMeta(db, 'nope')).toBeUndefined();

		expect(compareMessageParts(db, m.id, conversationId, m.parts)).toEqual({
			status: 'failed',
			error: 'boom',
			partsEqual: true
		});
		expect(compareMessageParts(db, m.id, conversationId, '[]')?.partsEqual).toBe(false);
		expect(compareMessageParts(db, m.id, 'other', m.parts)).toBeUndefined();
	});

	it('createMessage and insertMessageBefore return the row as stored', () => {
		const usage = {
			providerId: 'p',
			modelId: 'm',
			inputTokens: 1,
			outputTokens: 2,
			totalTokens: 3,
			latencyMs: null,
			costUsd: null
		};
		const first = createMessage(db, { conversationId, role: 'user', parts: [] });
		const reply = createMessage(db, {
			conversationId,
			role: 'assistant',
			parts: [{ type: 'text', text: 'answer' }],
			status: 'failed',
			error: 'boom',
			usage,
			createdAt: 7
		});
		expect(first).toEqual(getMessage(db, first.id));
		expect(reply).toEqual(getMessage(db, reply.id));

		const inserted = insertMessageBefore(db, reply.id, {
			conversationId,
			role: 'user',
			parts: [{ type: 'text', text: 'between' }],
			createdAt: 6
		});
		expect(inserted).toEqual(getMessage(db, inserted!.id));
		expect(inserted!.parent_id).toBe(first.id);
		expect(getMessage(db, reply.id)!.parent_id).toBe(inserted!.id);
		expect(
			insertMessageBefore(db, reply.id, { conversationId: 'other', role: 'user', parts: [] })
		).toBeUndefined();
	});

	it('partialSaveIntervalMs spaces saves out as a message grows, up to a cap', () => {
		expect(partialSaveIntervalMs(2_000, 500)).toBe(500);
		expect(partialSaveIntervalMs(16 * 1024, 1000)).toBe(1000);
		const mid = partialSaveIntervalMs(100_000, 1000);
		expect(mid).toBeGreaterThan(2000);
		expect(mid).toBeLessThan(4000);
		expect(partialSaveIntervalMs(400_000, 1000)).toBeGreaterThanOrEqual(5000);
		expect(partialSaveIntervalMs(5_000_000, 1000)).toBe(MAX_PARTIAL_SAVE_INTERVAL_MS);
	});

	it('updateMessage returns the row as stored', () => {
		const m = createMessage(db, { conversationId, role: 'assistant', parts: [] });
		const usage = {
			providerId: 'p',
			modelId: 'm',
			inputTokens: 3,
			outputTokens: 4,
			totalTokens: 7,
			latencyMs: 5,
			costUsd: null
		};
		const updated = updateMessage(db, m.id, {
			parts: [{ type: 'text', text: 'answer' }],
			usage
		});
		expect(updated).toEqual(getMessage(db, m.id));
		expect(updateMessage(db, m.id, { error: 'x', usage: null })).toEqual(getMessage(db, m.id));
		expect(updateMessage(db, 'nope', { status: 'complete' })).toBeUndefined();
	});

	it('extractText joins only text parts', () => {
		expect(
			extractText([
				{ type: 'reasoning', text: 'skip' },
				{ type: 'text', text: 'a' },
				{ type: 'text', text: 'b' }
			])
		).toBe('a\nb');
	});
});

describe('listMessagesFrom', () => {
	it('returns the anchor and every later message in order', () => {
		const a = createMessage(db, { conversationId, role: 'user', parts: [], createdAt: 1 });
		const b = createMessage(db, { conversationId, role: 'assistant', parts: [], createdAt: 2 });
		const c = createMessage(db, { conversationId, role: 'assistant', parts: [], createdAt: 2 });
		expect(listMessagesFrom(db, conversationId, b.id)!.map((r) => r.id)).toEqual([b.id, c.id]);
		expect(listMessagesFrom(db, conversationId, a.id)!.map((r) => r.id)).toEqual([
			a.id,
			b.id,
			c.id
		]);
	});

	it('returns undefined for an unknown or foreign anchor', () => {
		const other = createConversation(db, 'u1').id;
		const foreign = createMessage(db, { conversationId: other, role: 'user', parts: [] });
		expect(listMessagesFrom(db, conversationId, 'missing')).toBeUndefined();
		expect(listMessagesFrom(db, conversationId, foreign.id)).toBeUndefined();
	});
});

describe('listMessagesPage', () => {
	function seedMany(n: number) {
		// Same timestamp for all: the rowid has to break ties.
		return Array.from({ length: n }, (_, i) =>
			createMessage(db, {
				conversationId,
				role: i % 2 ? 'assistant' : 'user',
				parts: [{ type: 'text', text: `m${i}` }],
				createdAt: 1000
			})
		);
	}

	it('returns the newest messages oldest-first and pages backwards', () => {
		const all = seedMany(7);
		const first = listMessagesPage(db, conversationId, { limit: 3 })!;
		expect(first.rows.map((r) => r.id)).toEqual(all.slice(4).map((m) => m.id));
		expect(first.hasOlder).toBe(true);
		const second = listMessagesPage(db, conversationId, { before: first.rows[0].id, limit: 3 })!;
		expect(second.rows.map((r) => r.id)).toEqual(all.slice(1, 4).map((m) => m.id));
		expect(second.hasOlder).toBe(true);
		const last = listMessagesPage(db, conversationId, { before: second.rows[0].id, limit: 3 })!;
		expect(last.rows.map((r) => r.id)).toEqual([all[0].id]);
		expect(last.hasOlder).toBe(false);
	});

	it('reports no older messages when everything fits', () => {
		seedMany(3);
		const page = listMessagesPage(db, conversationId)!;
		expect(page.rows).toHaveLength(3);
		expect(page.hasOlder).toBe(false);
	});

	it('clamps the limit and rejects an anchor from another conversation', () => {
		seedMany(3);
		expect(listMessagesPage(db, conversationId, { limit: 0 })!.rows).toHaveLength(1);
		const other = createConversation(db, 'u1').id;
		const foreign = createMessage(db, { conversationId: other, role: 'user', parts: [] });
		expect(listMessagesPage(db, conversationId, { before: foreign.id })).toBeUndefined();
		expect(listMessagesPage(db, conversationId, { before: 'nope' })).toBeUndefined();
	});

	it('uses the conversation index', () => {
		const plan = db
			.prepare(
				`EXPLAIN QUERY PLAN SELECT rowid, * FROM messages WHERE conversation_id = ?
				 ORDER BY created_at DESC, rowid DESC LIMIT ?`
			)
			.all(conversationId, 61) as { detail: string }[];
		const details = plan.map((p) => p.detail).join(' | ');
		expect(details).toMatch(/USING INDEX/);
		expect(details).not.toMatch(/TEMP B-TREE/);
	});
});

describe('message tree', () => {
	const text = (t: string) => [{ type: 'text', text: t }];
	const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

	/** u1 → a1 → u2 → a2, then an edit of u2 (u2b → a2b) and a regenerate of a2b (a2c). */
	function branched() {
		const u1 = createMessage(db, { conversationId, role: 'user', parts: text('u1') });
		const a1 = createMessage(db, { conversationId, role: 'assistant', parts: text('a1') });
		const u2 = createMessage(db, { conversationId, role: 'user', parts: text('u2') });
		const a2 = createMessage(db, { conversationId, role: 'assistant', parts: text('a2') });
		const u2b = createMessage(db, {
			conversationId,
			role: 'user',
			parts: text('u2b'),
			parentId: a1.id
		});
		const a2b = createMessage(db, {
			conversationId,
			role: 'assistant',
			parts: text('a2b')
		});
		const a2c = createMessage(db, {
			conversationId,
			role: 'assistant',
			parts: text('a2c'),
			parentId: u2b.id
		});
		return { u1, a1, u2, a2, u2b, a2b, a2c };
	}

	it('links new messages to the active leaf by default', () => {
		const u1 = createMessage(db, { conversationId, role: 'user', parts: [] });
		const a1 = createMessage(db, { conversationId, role: 'assistant', parts: [] });
		expect(u1.parent_id).toBeNull();
		expect(a1.parent_id).toBe(u1.id);
		expect(activeLeafId(db, conversationId)).toBe(a1.id);
	});

	it('lists only the active path, in order', () => {
		const m = branched();
		expect(ids(listMessages(db, conversationId))).toEqual([m.u1.id, m.a1.id, m.u2b.id, m.a2c.id]);
		expect(activeLeafId(db, conversationId)).toBe(m.a2c.id);
	});

	it('switches to the newest leaf under another version', () => {
		const m = branched();
		expect(activateBranch(db, conversationId, m.u2.id)).toBe(m.a2.id);
		expect(ids(listMessages(db, conversationId))).toEqual([m.u1.id, m.a1.id, m.u2.id, m.a2.id]);
		// back to the edit: its newest reply (the regenerated one) is shown
		expect(activateBranch(db, conversationId, m.u2b.id)).toBe(m.a2c.id);
		expect(activateBranch(db, conversationId, m.a2b.id)).toBe(m.a2b.id);
		expect(ids(listMessages(db, conversationId))).toEqual([m.u1.id, m.a1.id, m.u2b.id, m.a2b.id]);
		// a message of another conversation is not a branch of this one
		const other = createConversation(db, 'u1');
		const foreign = createMessage(db, { conversationId: other.id, role: 'user', parts: [] });
		expect(activateBranch(db, conversationId, foreign.id)).toBeUndefined();
		expect(activateBranch(db, conversationId, 'nope')).toBeUndefined();
	});

	it('reports the versions of messages that have siblings', () => {
		const m = branched();
		const branches = branchesFor(db, conversationId, listMessages(db, conversationId));
		expect(branches.has(m.u1.id)).toBe(false);
		expect(branches.get(m.u2b.id)).toEqual({ index: 1, count: 2, ids: [m.u2.id, m.u2b.id] });
		expect(branches.get(m.a2c.id)).toEqual({ index: 1, count: 2, ids: [m.a2b.id, m.a2c.id] });
		const pub = toPublicWithBranches(db, conversationId, listMessages(db, conversationId));
		expect(pub.map((p) => p.branch?.count ?? 1)).toEqual([1, 1, 2, 2]);
	});

	it('reports root and nested sibling groups together, ordered by creation', () => {
		const m = branched();
		const r2 = createMessage(db, {
			conversationId,
			role: 'user',
			parts: text('r2'),
			parentId: null
		});
		const u2c = createMessage(db, {
			conversationId,
			role: 'user',
			parts: text('u2c'),
			parentId: m.a1.id
		});
		const branches = branchesFor(db, conversationId, [m.u1, r2, m.u2, u2c, m.a2b, m.a1]);
		expect(branches.get(m.u1.id)).toEqual({ index: 0, count: 2, ids: [m.u1.id, r2.id] });
		expect(branches.get(r2.id)).toEqual({ index: 1, count: 2, ids: [m.u1.id, r2.id] });
		const u2Group = [m.u2.id, m.u2b.id, u2c.id];
		expect(branches.get(m.u2.id)).toEqual({ index: 0, count: 3, ids: u2Group });
		expect(branches.get(u2c.id)).toEqual({ index: 2, count: 3, ids: u2Group });
		expect(branches.get(m.a2b.id)).toEqual({ index: 0, count: 2, ids: [m.a2b.id, m.a2c.id] });
		expect(branches.has(m.a1.id)).toBe(false);
		expect(branchesFor(db, conversationId, [{ id: 'nope' }]).size).toBe(0);
	});

	it('pages through the active path only', () => {
		const m = branched();
		const page = listMessagesPage(db, conversationId, { limit: 2 })!;
		expect(ids(page.rows)).toEqual([m.u2b.id, m.a2c.id]);
		expect(page.hasOlder).toBe(true);
		const older = listMessagesPage(db, conversationId, { before: m.u2b.id, limit: 2 })!;
		expect(ids(older.rows)).toEqual([m.u1.id, m.a1.id]);
		expect(older.hasOlder).toBe(false);
		// an anchor on another branch is not part of this history
		expect(listMessagesPage(db, conversationId, { before: m.a2.id })).toBeUndefined();
		expect(listMessagesAfter(db, conversationId, m.u2.id)).toBeUndefined();
		expect(ids(listMessagesAfter(db, conversationId, m.a1.id)!)).toEqual([m.u2b.id, m.a2c.id]);
		expect(ids(listMessagesFrom(db, conversationId, m.u2b.id)!)).toEqual([m.u2b.id, m.a2c.id]);
	});

	it('falls back to the older version when the active one is removed', () => {
		const m = branched();
		// e.g. a regenerated reply that ended without output
		deleteMessage(db, m.a2c.id);
		expect(ids(listMessages(db, conversationId))).toEqual([m.u1.id, m.a1.id, m.u2b.id, m.a2b.id]);
	});

	it('keeps later messages connected when a middle message is deleted', () => {
		const u1 = createMessage(db, { conversationId, role: 'user', parts: [] });
		const notice = createMessage(db, { conversationId, role: 'user', parts: [] });
		const a1 = createMessage(db, { conversationId, role: 'assistant', parts: [] });
		deleteMessage(db, notice.id);
		expect(ids(listMessages(db, conversationId))).toEqual([u1.id, a1.id]);
		const next = createMessage(db, { conversationId, role: 'user', parts: [] });
		expect(next.parent_id).toBe(a1.id);
	});

	it('orders the path by creation time even when messages were linked out of order', () => {
		// A mirrored turn can store its reply before the (earlier) user message.
		const reply = createMessage(db, {
			conversationId,
			role: 'assistant',
			parts: [],
			createdAt: 20
		});
		const user = createMessage(db, { conversationId, role: 'user', parts: [], createdAt: 10 });
		expect(ids(listMessages(db, conversationId))).toEqual([user.id, reply.id]);
	});

	it('uses the newest message when the active pointer is unset', () => {
		const u1 = createMessage(db, { conversationId, role: 'user', parts: [] });
		const a1 = createMessage(db, { conversationId, role: 'assistant', parts: [] });
		db.prepare('UPDATE conversations SET active_leaf_id = NULL').run();
		expect(activeLeafId(db, conversationId)).toBe(a1.id);
		expect(ids(listMessages(db, conversationId))).toEqual([u1.id, a1.id]);
	});

	it('keeps search over every version', () => {
		branched();
		const hits = (term: string) =>
			db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(term).length;
		expect(hits('a2')).toBe(1);
		expect(hits('a2c')).toBe(1);
	});

	it('listLatestMessages returns the tail of the active path oldest-first', () => {
		const m = branched();
		expect(ids(listLatestMessages(db, conversationId, 3))).toEqual([m.a1.id, m.u2b.id, m.a2c.id]);
		expect(ids(listLatestMessages(db, conversationId, 500))).toEqual(
			ids(listMessages(db, conversationId))
		);
		expect(ids(listLatestMessages(db, conversationId, 0))).toEqual([m.a2c.id]);
		activateBranch(db, conversationId, m.u2.id);
		expect(ids(listLatestMessages(db, conversationId, 2))).toEqual([m.u2.id, m.a2.id]);
		expect(listLatestMessages(db, createConversation(db, 'u1').id, 5)).toEqual([]);
	});

	it('deleteBranch removes a version with its subtree, without reattaching', () => {
		const m = branched();
		const result = deleteBranch(db, conversationId, m.u2b.id);
		expect(result).toMatchObject({ ok: true });
		expect(result.ok && [...result.deletedIds].sort()).toEqual(
			[m.u2b.id, m.a2b.id, m.a2c.id].sort()
		);
		// the active path moved to the remaining version's newest leaf
		expect(ids(listMessages(db, conversationId))).toEqual([m.u1.id, m.a1.id, m.u2.id, m.a2.id]);
		expect(deleteBranch(db, conversationId, m.u2.id)).toEqual({
			ok: false,
			reason: 'only_version'
		});
		expect(deleteBranch(db, conversationId, 'nope')).toEqual({ ok: false, reason: 'not_found' });
	});

	it('deleteBranch keeps the shown path when deleting another version', () => {
		const m = branched();
		deleteBranch(db, conversationId, m.a2b.id);
		expect(ids(listMessages(db, conversationId))).toEqual([m.u1.id, m.a1.id, m.u2b.id, m.a2c.id]);
		expect(activeLeafId(db, conversationId)).toBe(m.a2c.id);
	});
});
