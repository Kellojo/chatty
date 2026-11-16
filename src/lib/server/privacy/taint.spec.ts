import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

const { closeDb, getDb } = await import('../db/index.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { TurnPrivacy } = await import('./taint.js');
const { seedPrivacyFixture } = await import('./fixtures.js');

let fx: ReturnType<typeof seedPrivacyFixture>;
beforeEach(() => {
	closeDb();
	fx = seedPrivacyFixture(getDb());
});

describe('turn taint', () => {
	it('announces the promotion once, and only for a chat that was public', () => {
		const db = getDb();
		const open = createConversation(db, fx.userId, { private: false });
		const privacy = new TurnPrivacy(db, fx.userId, { conversationId: open.id, trust: 'trusted' });
		const seen: string[] = [];
		privacy.onPromoted = (reason) => seen.push(reason);
		privacy.markTainted('a private note');
		privacy.markTainted('a private chat');
		expect(seen).toEqual(['a private note']);

		const already = createConversation(db, fx.userId, { private: true });
		const quiet = new TurnPrivacy(db, fx.userId, { conversationId: already.id, trust: 'trusted' });
		quiet.onPromoted = (reason) => seen.push(reason);
		quiet.markTainted('a private note');
		expect(seen).toEqual(['a private note']);
	});

	it('writes the private flag before markTainted returns', () => {
		const db = getDb();
		const c = createConversation(db, fx.userId, { private: false });
		const privacy = new TurnPrivacy(db, fx.userId, { conversationId: c.id, trust: 'trusted' });
		expect(privacy.tainted).toBe(false);
		privacy.markTainted('read a private note');
		const row = db.prepare('SELECT private FROM conversations WHERE id = ?').get(c.id) as {
			private: number;
		};
		expect(row.private).toBe(1);
		expect(privacy.tainted).toBe(true);
	});

	it('starts tainted in a private chat and refuses to taint an untrusted turn', () => {
		const db = getDb();
		const c = createConversation(db, fx.userId, { private: true });
		expect(new TurnPrivacy(db, fx.userId, { conversationId: c.id, trust: 'trusted' }).tainted).toBe(
			true
		);
		const open = createConversation(db, fx.userId, { private: false });
		const untrusted = new TurnPrivacy(db, fx.userId, {
			conversationId: open.id,
			trust: 'untrusted'
		});
		expect(() => untrusted.markTainted('x')).toThrow();
		const row = db.prepare('SELECT private FROM conversations WHERE id = ?').get(open.id) as {
			private: number;
		};
		expect(row.private).toBe(0);
	});
});
