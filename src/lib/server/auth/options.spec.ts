import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/index.js';
import { promoteFirstUser } from './options.js';

function seed(db: ReturnType<typeof openDatabase>, ...ids: string[]) {
	const insert = db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
		 VALUES (?, ?, ?, 0, 0, 0, 'user')`
	);
	for (const id of ids) insert.run(id, `${id}@x.y`, id);
}

const roleOf = (db: ReturnType<typeof openDatabase>, id: string) =>
	(db.prepare('SELECT role FROM "user" WHERE id = ?').get(id) as { role: string }).role;

describe('promoteFirstUser', () => {
	it('promotes only the first user when two signups race', () => {
		const db = openDatabase(':memory:');
		// Both rows exist before either after-hook runs.
		seed(db, 'b-second', 'a-first');
		expect(promoteFirstUser(db, 'a-first')).toBe(false);
		expect(promoteFirstUser(db, 'b-second')).toBe(true);
		expect(roleOf(db, 'b-second')).toBe('admin');
		expect(roleOf(db, 'a-first')).toBe('user');
	});

	it('does nothing once an admin exists', () => {
		const db = openDatabase(':memory:');
		seed(db, 'u1');
		expect(promoteFirstUser(db, 'u1')).toBe(true);
		db.prepare(`DELETE FROM "user" WHERE id = 'u1'`).run();
		seed(db, 'u0', 'u2');
		db.prepare(`UPDATE "user" SET role = 'admin' WHERE id = 'u2'`).run();
		expect(promoteFirstUser(db, 'u0')).toBe(false);
		expect(roleOf(db, 'u0')).toBe('user');
	});
});
