import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { openDatabase } = await import('../index.js');
const repo = await import('./push-subscriptions.js');

type Db = ReturnType<typeof openDatabase>;

function seedUser(db: Db, id: string) {
	db.prepare(
		'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, 0, 0, \'user\')'
	).run(id, 'A', `${id}@example.com`);
}

const FUTURE = '2999-01-01T00:00:00.000Z';

function seedSession(db: Db, id: string, userId: string, expiresAt = FUTURE) {
	db.prepare(
		`INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
		 VALUES (?, ?, ?, 0, 0, ?)`
	).run(id, expiresAt, `token-${id}`, userId);
}

const sub = (n: number, sessionId = 's1') => ({
	sessionId,
	endpoint: `https://push.example.com/${n}`,
	p256dh: `p${n}`,
	auth: `a${n}`
});

describe('push-subscriptions repo', () => {
	let db: Db;

	beforeEach(() => {
		db = openDatabase(':memory:');
		seedUser(db, 'u1');
		seedUser(db, 'u2');
		seedSession(db, 's1', 'u1');
		seedSession(db, 's2', 'u2');
	});

	it('stores and lists the subscriptions of a user', () => {
		repo.upsertPushSubscription(db, 'u1', sub(1));
		repo.upsertPushSubscription(db, 'u1', sub(2));
		repo.upsertPushSubscription(db, 'u2', sub(3, 's2'));
		expect(repo.listPushSubscriptions(db, 'u1').map((s) => s.endpoint)).toEqual([
			sub(1).endpoint,
			sub(2).endpoint
		]);
	});

	it('re-subscribing the same endpoint replaces keys and owner', () => {
		repo.upsertPushSubscription(db, 'u1', sub(1));
		const row = repo.upsertPushSubscription(db, 'u2', { ...sub(1, 's2'), p256dh: 'new' });
		expect(row.user_id).toBe('u2');
		expect(row.session_id).toBe('s2');
		expect(repo.getPushSubscriptionOwner(db, sub(1).endpoint)).toBe('u2');
		expect(row.p256dh).toBe('new');
		expect(repo.listPushSubscriptions(db, 'u1')).toEqual([]);
	});

	it('only deletes the subscription of the caller', () => {
		repo.upsertPushSubscription(db, 'u1', sub(1));
		expect(repo.deletePushSubscription(db, 'u2', sub(1).endpoint)).toBe(false);
		expect(repo.deletePushSubscription(db, 'u1', sub(1).endpoint)).toBe(true);
		expect(repo.getPushSubscriptionOwner(db, sub(1).endpoint)).toBeNull();
	});

	it('drops a subscription after too many failures, and success resets the count', () => {
		const { id } = repo.upsertPushSubscription(db, 'u1', sub(1));
		for (let i = 0; i < repo.MAX_PUSH_FAILURES - 2; i++) repo.markPushFailure(db, id);
		repo.markPushSuccess(db, id, 123);
		const row = repo.listPushSubscriptions(db, 'u1')[0];
		expect(row.failure_count).toBe(0);
		expect(row.last_success_at).toBe(123);
		let removed = false;
		for (let i = 0; i < repo.MAX_PUSH_FAILURES; i++) removed = repo.markPushFailure(db, id);
		expect(removed).toBe(true);
		expect(repo.listPushSubscriptions(db, 'u1')).toEqual([]);
	});

	it('stops delivering once the session expires, and goes with a deleted session', () => {
		seedSession(db, 'short', 'u1', '2026-01-01T00:00:00.000Z');
		repo.upsertPushSubscription(db, 'u1', sub(1, 'short'));
		repo.upsertPushSubscription(db, 'u1', sub(2));
		const before = Date.parse('2025-12-31T00:00:00.000Z');
		const after = Date.parse('2026-01-02T00:00:00.000Z');
		expect(repo.listPushSubscriptions(db, 'u1', before)).toHaveLength(2);
		expect(repo.listPushSubscriptions(db, 'u1', after).map((s) => s.endpoint)).toEqual([
			sub(2).endpoint
		]);
		db.prepare('DELETE FROM "session" WHERE id = ?').run('s1');
		expect(repo.getPushSubscriptionOwner(db, sub(2).endpoint)).toBeNull();
	});

	it('is removed with its user', () => {
		repo.upsertPushSubscription(db, 'u1', sub(1));
		db.prepare('DELETE FROM "user" WHERE id = ?').run('u1');
		expect(repo.listPushSubscriptions(db, 'u1')).toEqual([]);
	});
});
