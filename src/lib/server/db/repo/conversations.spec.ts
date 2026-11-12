import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../index.js';
import {
	autoSettleConversations,
	countSettledConversations,
	createConversation,
	getConversation,
	listConversations,
	listConversationsSince,
	listSettledConversations,
	markConversationRead,
	searchConversations,
	searchConversationsSql,
	listSnoozedConversations,
	settleConversation,
	snoozeConversation,
	softDeleteConversation,
	togglePin,
	unsettleConversation,
	unsnoozeConversation,
	updateConversation,
	wakeDueSnoozes
} from './conversations.js';
import { activateBranch, createMessage } from './messages.js';

let db: Db;

beforeEach(() => {
	db = openDatabase(':memory:');
	db.prepare(
		'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u1\', \'a@b.c\', \'A\', 0, 0, 0, \'user\')'
	).run();
	db.prepare(
		'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u2\', \'d@e.f\', \'D\', 0, 0, 0, \'user\')'
	).run();
});

describe('conversations repo', () => {
	it('lists only own, non-deleted chat conversations, pinned first', () => {
		const a = createConversation(db, 'u1', { title: 'a' });
		const b = createConversation(db, 'u1', { title: 'b' });
		createConversation(db, 'u2', { title: 'other user' });
		createConversation(db, 'u1', { title: 'run', kind: 'agent-run' });
		togglePin(db, 'u1', b.id);
		const list = listConversations(db, 'u1');
		expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
		softDeleteConversation(db, 'u1', a.id);
		expect(listConversations(db, 'u1').map((c) => c.id)).toEqual([b.id]);
	});

	it('getConversation enforces ownership', () => {
		const c = createConversation(db, 'u1');
		expect(getConversation(db, 'u1', c.id)).toBeDefined();
		expect(getConversation(db, 'u2', c.id)).toBeUndefined();
	});

	it('updateConversation patches fields', () => {
		const c = createConversation(db, 'u1');
		const updated = updateConversation(db, 'u1', c.id, {
			title: 'new',
			mode: 'agent',
			memoryEnabled: true,
			maxSteps: 10
		});
		expect(updated!.title).toBe('new');
		expect(updated!.mode).toBe('agent');
		expect(updated!.memory_enabled).toBe(1);
		expect(updated!.max_steps).toBe(10);
	});

	it('searchConversations matches title and message content (FTS)', () => {
		const byTitle = createConversation(db, 'u1', { title: 'quarterly budget' });
		const byContent = createConversation(db, 'u1', { title: 'random' });
		createMessage(db, {
			conversationId: byContent.id,
			role: 'user',
			parts: [{ type: 'text', text: 'tell me about the quarterly budget' }]
		});
		createConversation(db, 'u1', { title: 'unrelated' });
		const hits = searchConversations(db, 'u1', 'quarterly');
		expect(new Set(hits.map((c) => c.id))).toEqual(new Set([byTitle.id, byContent.id]));
	});

	it('searchConversations treats LIKE wildcards literally', () => {
		const pct = createConversation(db, 'u1', { title: 'growth 100% done' });
		createConversation(db, 'u1', { title: 'growth 1000 done' });
		const under = createConversation(db, 'u1', { title: 'snake_case' });
		createConversation(db, 'u1', { title: 'snakeXcase' });
		expect(searchConversations(db, 'u1', '100%').map((c) => c.id)).toEqual([pct.id]);
		expect(searchConversations(db, 'u1', 'snake_case').map((c) => c.id)).toEqual([under.id]);
		expect(searchConversations(db, 'u1', '%').map((c) => c.id)).toEqual([pct.id]);
	});

	it('searchConversations never throws on FTS syntax in user input', () => {
		const c = createConversation(db, 'u1', { title: 'x' });
		createMessage(db, {
			conversationId: c.id,
			role: 'user',
			parts: [{ type: 'text', text: 'near the content of a column' }]
		});
		for (const q of [
			'"',
			'"unbalanced',
			'a AND',
			'OR',
			'NEAR(',
			'content:',
			'*',
			'-',
			'^near',
			'(content',
			"it's",
			'{x y}: z'
		]) {
			expect(() => searchConversations(db, 'u1', q)).not.toThrow();
		}
		expect(searchConversations(db, 'u1', 'NEAR(content').map((h) => h.id)).toEqual([c.id]);
		expect(searchConversations(db, 'u1', 'content:').map((h) => h.id)).toEqual([c.id]);
	});

	it('searchConversations pages with limit and offset', () => {
		const ids = Array.from({ length: 5 }, (_, i) => {
			const c = createConversation(db, 'u1', { title: `topic ${i}` });
			db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(1000 + i, c.id);
			return c.id;
		});
		expect(searchConversations(db, 'u1', 'topic', { limit: 2 }).map((c) => c.id)).toEqual([
			ids[4],
			ids[3]
		]);
		expect(
			searchConversations(db, 'u1', 'topic', { limit: 2, offset: 4 }).map((c) => c.id)
		).toEqual([ids[0]]);
	});

	it('searchConversations runs FTS once and walks the user index', () => {
		const plan = db
			.prepare(`EXPLAIN QUERY PLAN ${searchConversationsSql(true)}`)
			.all('"a"*', 'u1', 'u1', '%a%', '%a%', 50, 0) as { detail: string }[];
		const details = plan.map((p) => p.detail);
		expect(details.some((d) => /SEARCH c USING INDEX/.test(d))).toBe(true);
		expect(details.some((d) => /VIRTUAL TABLE INDEX/.test(d))).toBe(true);
		expect(details.some((d) => /CORRELATED/.test(d))).toBe(false);
		// No full scan of conversations or messages: only the FTS hits and the
		// CTEs built from them are scanned.
		expect(details.filter((d) => /^SCAN (c|hc|m)\b/.test(d))).toEqual([]);
	});

	it('searchConversations matches message text only on the shown version', () => {
		const c = createConversation(db, 'u1', { title: 'branches' });
		const text = (t: string) => [{ type: 'text', text: t }];
		const original = createMessage(db, {
			conversationId: c.id,
			role: 'user',
			parts: text('original zebra question')
		}).id;
		createMessage(db, { conversationId: c.id, role: 'assistant', parts: text('shared reply') });
		// an edit starts a new version from the root, which becomes the shown one
		const edit = createMessage(db, {
			conversationId: c.id,
			role: 'user',
			parts: text('edited giraffe question'),
			parentId: null
		}).id;
		createMessage(db, { conversationId: c.id, role: 'assistant', parts: text('newer answer') });
		expect(searchConversations(db, 'u1', 'zebra')).toEqual([]);
		expect(searchConversations(db, 'u1', 'giraffe').map((h) => h.id)).toEqual([c.id]);
		expect(searchConversations(db, 'u1', 'shared')).toEqual([]);

		activateBranch(db, c.id, original);
		expect(searchConversations(db, 'u1', 'zebra').map((h) => h.id)).toEqual([c.id]);
		expect(searchConversations(db, 'u1', 'shared').map((h) => h.id)).toEqual([c.id]);
		expect(searchConversations(db, 'u1', 'giraffe')).toEqual([]);
		// title matches don't depend on the version
		expect(searchConversations(db, 'u1', 'branches').map((h) => h.id)).toEqual([c.id]);
		activateBranch(db, c.id, edit);
		expect(searchConversations(db, 'u1', 'giraffe').map((h) => h.id)).toEqual([c.id]);
	});

	it('searchConversations still matches messages of a conversation without a leaf pointer', () => {
		const c = createConversation(db, 'u1');
		createMessage(db, {
			conversationId: c.id,
			role: 'user',
			parts: [{ type: 'text', text: 'okapi' }]
		});
		db.prepare('UPDATE conversations SET active_leaf_id = NULL WHERE id = ?').run(c.id);
		expect(searchConversations(db, 'u1', 'okapi').map((h) => h.id)).toEqual([c.id]);
		expect(searchConversations(db, 'u2', 'okapi')).toEqual([]);
	});

	it('searchConversations matches a coding task by its project name', () => {
		const task = createConversation(db, 'u1', { title: 'fix the tests' });
		db.prepare(
			`INSERT INTO coding_conversations (conversation_id, project_id, project_title,
			   provider_instance_id, model, runtime_mode, created_at, updated_at)
			 VALUES (?, 'p1', 'kellojo-website', 'codex', 'gpt', 'full-access', 0, 0)`
		).run(task.id);
		createConversation(db, 'u1', { title: 'unrelated' });
		const hits = searchConversations(db, 'u1', 'website');
		expect(hits.map((c) => c.id)).toEqual([task.id]);
		expect(hits[0].coding_project_title).toBe('kellojo-website');
	});

	it('pages with limit and offset', () => {
		const ids = Array.from({ length: 5 }, (_, i) => {
			const c = createConversation(db, 'u1', { title: `c${i}` });
			db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(1000 + i, c.id);
			return c.id;
		});
		const page1 = listConversations(db, 'u1', { limit: 2 });
		expect(page1.map((c) => c.id)).toEqual([ids[4], ids[3]]);
		const page2 = listConversations(db, 'u1', { limit: 2, offset: 2 });
		expect(page2.map((c) => c.id)).toEqual([ids[2], ids[1]]);
		const page3 = listConversations(db, 'u1', { limit: 2, offset: 4 });
		expect(page3.map((c) => c.id)).toEqual([ids[0]]);
	});
});

describe('settling conversations', () => {
	const DAY = 24 * 60 * 60 * 1000;

	function age(id: string, ms: number, lastReadAt: number | null = null) {
		db.prepare(
			'UPDATE conversations SET created_at = ?, updated_at = ?, last_read_at = ? WHERE id = ?'
		).run(ms, ms, lastReadAt, id);
	}

	it('settles manually, unpins, and hides from the default list', () => {
		const a = createConversation(db, 'u1', { title: 'a' });
		const b = createConversation(db, 'u1', { title: 'b' });
		togglePin(db, 'u1', a.id);
		const settled = settleConversation(db, 'u1', a.id);
		expect(settled!.settled_reason).toBe('manual');
		expect(settled!.settled_at).not.toBeNull();
		expect(settled!.pinned).toBe(0);
		expect(listConversations(db, 'u1').map((c) => c.id)).toEqual([b.id]);
		expect(listSettledConversations(db, 'u1').map((c) => c.id)).toEqual([a.id]);
		expect(countSettledConversations(db, 'u1')).toBe(1);
		// Still directly accessible and visible to time-based lookups.
		expect(getConversation(db, 'u1', a.id)).toBeDefined();
		expect(listConversationsSince(db, 'u1', 0).map((c) => c.id)).toContain(a.id);
	});

	it("does not settle another user's conversation", () => {
		const c = createConversation(db, 'u1');
		expect(settleConversation(db, 'u2', c.id)).toBeUndefined();
		expect(getConversation(db, 'u1', c.id)!.settled_at).toBeNull();
	});

	it('un-settles and records a look so it is not instantly re-settled', () => {
		const c = createConversation(db, 'u1');
		age(c.id, 1000);
		settleConversation(db, 'u1', c.id);
		const before = Date.now();
		const row = unsettleConversation(db, 'u1', c.id);
		expect(row!.settled_at).toBeNull();
		expect(row!.settled_reason).toBeNull();
		expect(row!.last_read_at).toBeGreaterThanOrEqual(before);
		expect(autoSettleConversations(db, { cutoffMs: before - DAY }).size).toBe(0);
		expect(listConversations(db, 'u1').map((r) => r.id)).toEqual([c.id]);
	});

	it('lists settled conversations newest-settled first with paging', () => {
		const ids = Array.from({ length: 3 }, (_, i) => {
			const c = createConversation(db, 'u1', { title: `c${i}` });
			settleConversation(db, 'u1', c.id);
			db.prepare('UPDATE conversations SET settled_at = ? WHERE id = ?').run(1000 + i, c.id);
			return c.id;
		});
		expect(listSettledConversations(db, 'u1', { limit: 2 }).map((c) => c.id)).toEqual([
			ids[2],
			ids[1]
		]);
		expect(listSettledConversations(db, 'u1', { limit: 2, offset: 2 }).map((c) => c.id)).toEqual([
			ids[0]
		]);
		expect(countSettledConversations(db, 'u2')).toBe(0);
	});

	it('auto-settles idle chats with reason auto, grouped by user', () => {
		const now = Date.now();
		const old1 = createConversation(db, 'u1', { title: 'old1' });
		const old2 = createConversation(db, 'u2', { title: 'old2' });
		const fresh = createConversation(db, 'u1', { title: 'fresh' });
		age(old1.id, now - 10 * DAY);
		age(old2.id, now - 10 * DAY);
		const result = autoSettleConversations(db, { cutoffMs: now - 7 * DAY });
		expect(result.get('u1')).toEqual([old1.id]);
		expect(result.get('u2')).toEqual([old2.id]);
		const row = getConversation(db, 'u1', old1.id)!;
		expect(row.settled_reason).toBe('auto');
		expect(row.settled_at).not.toBeNull();
		expect(getConversation(db, 'u1', fresh.id)!.settled_at).toBeNull();
		// Already settled conversations are not settled again.
		expect(autoSettleConversations(db, { cutoffMs: now - 7 * DAY }).size).toBe(0);
	});

	it('exempts pinned, excluded, recently read, deleted and non-chat conversations', () => {
		const now = Date.now();
		const old = now - 10 * DAY;
		const pinned = createConversation(db, 'u1', { title: 'pinned' });
		togglePin(db, 'u1', pinned.id);
		const streaming = createConversation(db, 'u1', { title: 'streaming' });
		const recentlyRead = createConversation(db, 'u1', { title: 'read' });
		const deleted = createConversation(db, 'u1', { title: 'deleted' });
		const run = createConversation(db, 'u1', { title: 'run', kind: 'agent-run' });
		for (const c of [pinned, streaming, recentlyRead, deleted, run]) age(c.id, old);
		markConversationRead(db, 'u1', recentlyRead.id);
		softDeleteConversation(db, 'u1', deleted.id);
		const result = autoSettleConversations(db, {
			cutoffMs: now - 7 * DAY,
			excludeIds: [streaming.id]
		});
		expect(result.size).toBe(0);
		expect(countSettledConversations(db, 'u1')).toBe(0);
	});

	it('search includes settled conversations and exposes settled_at', () => {
		const c = createConversation(db, 'u1', { title: 'quarterly report' });
		settleConversation(db, 'u1', c.id);
		const hits = searchConversations(db, 'u1', 'quarterly');
		expect(hits.map((h) => h.id)).toEqual([c.id]);
		expect(hits[0].settled_at).not.toBeNull();
	});

	describe('snooze', () => {
		const HOUR = 60 * 60 * 1000;

		it('hides a snoozed chat from the active list until it wakes, and unpins it', () => {
			const now = Date.now();
			const a = createConversation(db, 'u1', { title: 'a' });
			const b = createConversation(db, 'u1', { title: 'b' });
			togglePin(db, 'u1', a.id);
			const row = snoozeConversation(db, 'u1', a.id, now + HOUR, now)!;
			expect(row.pinned).toBe(0);
			expect(row.snoozed_at).toBe(now);
			expect(listConversations(db, 'u1', { now }).map((c) => c.id)).toEqual([b.id]);
			expect(listSnoozedConversations(db, 'u1', { now }).map((c) => c.id)).toEqual([a.id]);
			// Past its time it shows again even before the waker runs.
			expect(listConversations(db, 'u1', { now: now + 2 * HOUR }).map((c) => c.id)).toContain(a.id);
			expect(listSnoozedConversations(db, 'u1', { now: now + 2 * HOUR })).toEqual([]);
		});

		it('wakes due snoozes, sorting them as activity at their wake time', () => {
			const now = Date.now();
			const a = createConversation(db, 'u1', { title: 'a' });
			const b = createConversation(db, 'u1', { title: 'b' });
			const c = createConversation(db, 'u2', { title: 'c' });
			db.prepare('UPDATE conversations SET updated_at = ?').run(now - DAY);
			db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now - HOUR, b.id);
			snoozeConversation(db, 'u1', a.id, now - 1000, now - DAY);
			snoozeConversation(db, 'u2', c.id, now + HOUR, now);
			const woken = wakeDueSnoozes(db, now);
			expect([...woken]).toEqual([['u1', [a.id]]]);
			const row = getConversation(db, 'u1', a.id)!;
			expect(row.snoozed_until).toBeNull();
			expect(row.woke_at).toBe(now - 1000);
			expect(listConversations(db, 'u1', { now }).map((r) => r.id)).toEqual([a.id, b.id]);
			expect(getConversation(db, 'u2', c.id)!.snoozed_until).toBe(now + HOUR);
		});

		it('ends early on unsnooze, pin and settle', () => {
			const now = Date.now();
			const c = createConversation(db, 'u1');
			snoozeConversation(db, 'u1', c.id, now + HOUR, now);
			expect(unsnoozeConversation(db, 'u1', c.id, now + 5)).toBe(true);
			expect(getConversation(db, 'u1', c.id)!.woke_at).toBe(now + 5);
			expect(unsnoozeConversation(db, 'u1', c.id)).toBe(false);

			snoozeConversation(db, 'u1', c.id, now + HOUR, now);
			togglePin(db, 'u1', c.id);
			expect(getConversation(db, 'u1', c.id)!.snoozed_until).toBeNull();

			snoozeConversation(db, 'u1', c.id, now + HOUR, now);
			settleConversation(db, 'u1', c.id);
			expect(getConversation(db, 'u1', c.id)!.snoozed_until).toBeNull();
		});

		it('refuses to snooze a settled chat, and does not auto-settle a snoozed one', () => {
			const now = Date.now();
			const settled = createConversation(db, 'u1');
			settleConversation(db, 'u1', settled.id);
			expect(snoozeConversation(db, 'u1', settled.id, now + HOUR)!.snoozed_until).toBeNull();

			const snoozed = createConversation(db, 'u1');
			age(snoozed.id, now - 10 * DAY);
			snoozeConversation(db, 'u1', snoozed.id, now + 30 * DAY, now - 10 * DAY);
			expect(autoSettleConversations(db, { cutoffMs: now - 7 * DAY }).size).toBe(0);
		});
	});
});
