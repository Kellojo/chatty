import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../index.js';
import {
	deleteUser,
	deleteUserSessions,
	getUser,
	listUsers,
	renameUser,
	setUserRole
} from './users.js';

let db: Db;

function insertUser(id: string, role: 'admin' | 'user') {
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
		 VALUES (?, ?, ?, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`
	).run(id, `${id}@example.com`, id.toUpperCase(), role);
}

function insertSession(userId: string, updatedAt: string) {
	db.prepare(
		`INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
		 VALUES (?, '2099-01-01', ?, ?, ?, ?)`
	).run(`s-${userId}-${updatedAt}`, `t-${userId}-${updatedAt}`, updatedAt, updatedAt, userId);
}

beforeEach(() => {
	db = openDatabase(':memory:');
	insertUser('admin1', 'admin');
	insertUser('u1', 'user');
	db.prepare(
		`INSERT INTO "account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
		 VALUES ('a1', 'u1', 'credential', 'u1', 'hash', 0, 0), ('a2', 'sub', 'oidc', 'u1', NULL, 0, 0)`
	).run();
});

describe('users repo', () => {
	it('lists users in signup order with sign-in methods and last activity', () => {
		insertSession('u1', '2026-03-01T00:00:00.000Z');
		insertSession('u1', '2026-04-01T00:00:00.000Z');
		const users = listUsers(db);
		expect(users.map((u) => u.id)).toEqual(['admin1', 'u1']);
		expect(users[0]).toMatchObject({ role: 'admin', lastActiveAt: null, hasPassword: false });
		expect(users[1]).toMatchObject({
			role: 'user',
			signInMethods: ['credential', 'oidc'],
			hasPassword: true,
			createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
			lastActiveAt: Date.parse('2026-04-01T00:00:00.000Z')
		});
	});

	it('promotes and demotes, but never the last admin', () => {
		expect(setUserRole(db, 'admin1', 'user')).toMatchObject({ ok: false, status: 400 });
		expect(setUserRole(db, 'u1', 'admin')).toEqual({ ok: true });
		expect(setUserRole(db, 'admin1', 'user')).toEqual({ ok: true });
		expect(getUser(db, 'admin1')?.role).toBe('user');
		expect(setUserRole(db, 'missing', 'admin')).toMatchObject({ ok: false, status: 404 });
	});

	it('renames users', () => {
		expect(renameUser(db, 'u1', 'New Name')).toEqual({ ok: true });
		expect(getUser(db, 'u1')?.name).toBe('New Name');
		expect(renameUser(db, 'missing', 'x')).toMatchObject({ ok: false, status: 404 });
	});

	it('deletes users with their sessions and accounts, but not the last admin', () => {
		insertSession('u1', '2026-03-01T00:00:00.000Z');
		expect(deleteUser(db, 'admin1')).toMatchObject({ ok: false, status: 400 });
		expect(deleteUser(db, 'u1')).toEqual({ ok: true });
		expect(getUser(db, 'u1')).toBeNull();
		const left = db.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE "userId" = 'u1'`).get();
		expect(left).toEqual({ n: 0 });
	});

	it('signs a user out everywhere', () => {
		insertSession('u1', '2026-03-01T00:00:00.000Z');
		insertSession('u1', '2026-04-01T00:00:00.000Z');
		expect(deleteUserSessions(db, 'u1')).toBe(2);
		expect(getUser(db, 'u1')?.lastActiveAt).toBeNull();
	});
});
