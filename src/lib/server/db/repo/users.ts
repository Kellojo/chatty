import type { AdminUser, UserRole } from '$lib/types.js';
import type { Db } from '../index.js';

/** better-auth's `user` table, plus sign-in info joined from `account` and `session`. */
interface UserListRow {
	id: string;
	name: string;
	email: string;
	image: string | null;
	role: string;
	createdAt: string | number;
	lastActiveAt: string | number | null;
	providers: string | null;
}

/** better-auth stores dates as ISO strings in SQLite; older rows or tests may hold epoch ms. */
function toMillis(value: string | number | null): number | null {
	if (value === null || value === undefined) return null;
	const ms = typeof value === 'number' ? value : new Date(value).getTime();
	return Number.isFinite(ms) ? ms : null;
}

function toPublic(row: UserListRow): AdminUser {
	const signInMethods = row.providers ? [...new Set(row.providers.split(','))].sort() : [];
	return {
		id: row.id,
		name: row.name,
		email: row.email,
		image: row.image,
		role: row.role === 'admin' ? 'admin' : 'user',
		createdAt: toMillis(row.createdAt) ?? 0,
		lastActiveAt: toMillis(row.lastActiveAt),
		signInMethods,
		hasPassword: signInMethods.includes('credential')
	};
}

const LIST_SQL = `
	SELECT u.id, u.name, u.email, u.image, u.role, u."createdAt",
	       (SELECT MAX(s."updatedAt") FROM "session" s WHERE s."userId" = u.id) AS "lastActiveAt",
	       (SELECT GROUP_CONCAT(a."providerId") FROM "account" a WHERE a."userId" = u.id) AS providers
	FROM "user" u`;

export function listUsers(db: Db): AdminUser[] {
	const rows = db.prepare(`${LIST_SQL} ORDER BY u.rowid`).all() as UserListRow[];
	return rows.map(toPublic);
}

export function getUser(db: Db, id: string): AdminUser | null {
	const row = db.prepare(`${LIST_SQL} WHERE u.id = ?`).get(id) as UserListRow | undefined;
	return row ? toPublic(row) : null;
}

export function countAdmins(db: Db): number {
	return (
		db.prepare(`SELECT COUNT(*) AS n FROM "user" WHERE role = 'admin'`).get() as { n: number }
	).n;
}

export type UserMutationResult = { ok: true } | { ok: false; status: 400 | 404; message: string };

/**
 * Changes a user's role. Refuses to demote the last remaining admin, so the
 * instance can't be locked out of its admin settings. Runs in a transaction so
 * two concurrent demotions can't both pass the check.
 */
export function setUserRole(db: Db, id: string, role: UserRole): UserMutationResult {
	return db.transaction((): UserMutationResult => {
		const current = db.prepare(`SELECT role FROM "user" WHERE id = ?`).get(id) as
			{ role: string } | undefined;
		if (!current) return { ok: false, status: 404, message: 'User not found' };
		if (current.role === role) return { ok: true };
		if (current.role === 'admin' && countAdmins(db) <= 1) {
			return { ok: false, status: 400, message: 'At least one admin is required' };
		}
		db.prepare(`UPDATE "user" SET role = ?, "updatedAt" = ? WHERE id = ?`).run(
			role,
			new Date().toISOString(),
			id
		);
		return { ok: true };
	})();
}

export function renameUser(db: Db, id: string, name: string): UserMutationResult {
	const changes = db
		.prepare(`UPDATE "user" SET name = ?, "updatedAt" = ? WHERE id = ?`)
		.run(name, new Date().toISOString(), id).changes;
	return changes > 0 ? { ok: true } : { ok: false, status: 404, message: 'User not found' };
}

/**
 * Deletes a user. Their sessions, accounts, conversations, agents, API keys and
 * settings go with them via `ON DELETE CASCADE`. Refuses the last admin.
 */
export function deleteUser(db: Db, id: string): UserMutationResult {
	return db.transaction((): UserMutationResult => {
		const current = db.prepare(`SELECT role FROM "user" WHERE id = ?`).get(id) as
			{ role: string } | undefined;
		if (!current) return { ok: false, status: 404, message: 'User not found' };
		if (current.role === 'admin' && countAdmins(db) <= 1) {
			return { ok: false, status: 400, message: "The last admin can't be deleted" };
		}
		db.prepare(`DELETE FROM "user" WHERE id = ?`).run(id);
		return { ok: true };
	})();
}

/** Signs a user out everywhere. */
export function deleteUserSessions(db: Db, id: string): number {
	return db.prepare(`DELETE FROM "session" WHERE "userId" = ?`).run(id).changes;
}
