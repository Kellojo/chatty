import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrate.js';
import { listMessages } from './repo/messages.js';

const MIGRATION = '0047_message_branches.sql';
const source = path.join(process.cwd(), 'migrations');
let dir: string | null = null;

afterEach(async () => {
	if (dir) await fs.rm(dir, { recursive: true, force: true });
	dir = null;
});

/** A database migrated up to (not including) the branches migration. */
async function databaseBeforeBranches() {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatty-migrations-'));
	for (const file of await fs.readdir(source)) {
		if (file.endsWith('.sql') && file < MIGRATION) {
			await fs.copyFile(path.join(source, file), path.join(dir, file));
		}
	}
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	migrate(db, dir);
	return { db, dir };
}

describe('0047_message_branches', () => {
	it('links existing linear histories and points each conversation at its newest message', async () => {
		const { db, dir } = await databaseBeforeBranches();
		db.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
			 VALUES ('u1', 'a@b.c', 'A', 0, 0, 0, 'user')`
		).run();
		const conv = db.prepare(
			`INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES (?, 'u1', 0, 0)`
		);
		conv.run('c1');
		conv.run('c2');
		conv.run('empty');
		const msg = db.prepare(
			`INSERT INTO messages (id, conversation_id, role, parts, created_at) VALUES (?, ?, ?, '[]', ?)`
		);
		// Inserted out of time order, and with a timestamp tie broken by rowid.
		msg.run('c1-b', 'c1', 'assistant', 20);
		msg.run('c1-a', 'c1', 'user', 10);
		msg.run('c2-a', 'c2', 'user', 15);
		msg.run('c1-c', 'c1', 'user', 20);

		await fs.copyFile(path.join(source, MIGRATION), path.join(dir, MIGRATION));
		migrate(db, dir);

		const parents = Object.fromEntries(
			(
				db.prepare('SELECT id, parent_id FROM messages').all() as {
					id: string;
					parent_id: string;
				}[]
			).map((r) => [r.id, r.parent_id])
		);
		expect(parents).toEqual({ 'c1-a': null, 'c1-b': 'c1-a', 'c1-c': 'c1-b', 'c2-a': null });
		const leaves = Object.fromEntries(
			(
				db.prepare('SELECT id, active_leaf_id FROM conversations').all() as {
					id: string;
					active_leaf_id: string | null;
				}[]
			).map((r) => [r.id, r.active_leaf_id])
		);
		expect(leaves).toEqual({ c1: 'c1-c', c2: 'c2-a', empty: null });
		expect(listMessages(db, 'c1').map((m) => m.id)).toEqual(['c1-a', 'c1-b', 'c1-c']);
		db.close();
	});
});
