import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';

/** Consecutive non-fatal send failures after which a subscription is dropped. */
export const MAX_PUSH_FAILURES = 10;

export interface PushSubscriptionRow {
	id: string;
	user_id: string;
	/** The session that registered it; deliveries stop when it ends. */
	session_id: string | null;
	endpoint: string;
	p256dh: string;
	auth: string;
	user_agent: string | null;
	created_at: number;
	last_success_at: number | null;
	failure_count: number;
}

export interface PushSubscriptionInput {
	sessionId: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	userAgent?: string | null;
}

/**
 * Stores a browser's subscription for the user. An endpoint is unique per
 * browser install, so re-subscribing (new keys, or another account signing in
 * on the same device) replaces the row instead of adding one.
 */
export function upsertPushSubscription(
	db: Db,
	userId: string,
	input: PushSubscriptionInput
): PushSubscriptionRow {
	db.prepare(
		`INSERT INTO push_subscriptions
		   (id, user_id, session_id, endpoint, p256dh, auth, user_agent, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(endpoint) DO UPDATE SET
		   user_id = excluded.user_id, session_id = excluded.session_id, p256dh = excluded.p256dh,
		   auth = excluded.auth, user_agent = excluded.user_agent, failure_count = 0`
	).run(
		randomUUID(),
		userId,
		input.sessionId,
		input.endpoint,
		input.p256dh,
		input.auth,
		input.userAgent ?? null,
		Date.now()
	);
	return db
		.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?')
		.get(input.endpoint) as PushSubscriptionRow;
}

/** The user's subscriptions whose session is still live: the ones to deliver to. */
export function listPushSubscriptions(
	db: Db,
	userId: string,
	now = Date.now()
): PushSubscriptionRow[] {
	// julianday() reads better-auth's ISO date strings; a plain string compare would
	// silently break if the stored format ever changed.
	return db
		.prepare(
			`SELECT p.* FROM push_subscriptions p
			 JOIN "session" s ON s.id = p.session_id AND s."userId" = p.user_id
			 WHERE p.user_id = ? AND julianday(s."expiresAt") > julianday(?)
			 ORDER BY p.created_at`
		)
		.all(userId, new Date(now).toISOString()) as PushSubscriptionRow[];
}

/** Who holds an endpoint, if anyone: lets a device tell its own registration from another account's. */
export function getPushSubscriptionOwner(db: Db, endpoint: string): string | null {
	const row = db
		.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?')
		.get(endpoint) as { user_id: string } | undefined;
	return row?.user_id ?? null;
}

export function deletePushSubscription(db: Db, userId: string, endpoint: string): boolean {
	return (
		db
			.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
			.run(userId, endpoint).changes > 0
	);
}

export function deletePushSubscriptionById(db: Db, id: string): void {
	db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
}

export function markPushSuccess(db: Db, id: string, at = Date.now()): void {
	db.prepare(
		'UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE id = ?'
	).run(at, id);
}

/** Counts a failed send; returns true when the subscription hit the limit and was removed. */
export function markPushFailure(db: Db, id: string): boolean {
	const row = db
		.prepare(
			'UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ? RETURNING failure_count'
		)
		.get(id) as { failure_count: number } | undefined;
	if (row && row.failure_count >= MAX_PUSH_FAILURES) {
		deletePushSubscriptionById(db, id);
		return true;
	}
	return false;
}

/**
 * Deletes subscriptions that can no longer be delivered to: their session has
 * expired, or they predate session binding. A device still in use re-registers
 * itself the next time it opens Chatty.
 */
export function deleteStalePushSubscriptions(db: Db, now = Date.now()): number {
	return db
		.prepare(
			`DELETE FROM push_subscriptions WHERE session_id IS NULL
			   OR NOT EXISTS (SELECT 1 FROM "session" s WHERE s.id = session_id AND julianday(s."expiresAt") > julianday(?))`
		)
		.run(new Date(now).toISOString()).changes;
}
