import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrate.js';

const MIGRATION = '0087_gateway_default_backfill.sql';
const source = path.join(process.cwd(), 'migrations');
let dir: string | null = null;

afterEach(async () => {
	if (dir) await fs.rm(dir, { recursive: true, force: true });
	dir = null;
});

describe('0087_gateway_default_backfill', () => {
	it("writes out old keys' default access, chat search and memory included", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatty-migrations-'));
		for (const file of await fs.readdir(source)) {
			if (file.endsWith('.sql') && file < MIGRATION) {
				await fs.copyFile(path.join(source, file), path.join(dir, file));
			}
		}
		const db = new Database(':memory:');
		migrate(db, dir);
		db.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
			 VALUES ('u1', 'a@b.c', 'A', 0, 0, 0, 'user')`
		).run();
		const insert = db.prepare(
			`INSERT INTO api_keys (id, user_id, label, hash, scopes, created_at, mcp_access)
			 VALUES (?, 'u1', ?, ?, '["mcp:use"]', 0, ?)`
		);
		insert.run('k1', 'defaults', 'h1', null);
		const explicit = JSON.stringify([{ serverId: 'builtin-math', tools: null }]);
		insert.run('k2', 'explicit', 'h2', explicit);

		await fs.copyFile(path.join(source, MIGRATION), path.join(dir, MIGRATION));
		migrate(db, dir);

		const access = (id: string) =>
			(db.prepare('SELECT mcp_access FROM api_keys WHERE id = ?').get(id) as { mcp_access: string })
				.mcp_access;
		const names = (JSON.parse(access('k1')) as { serverId: string; tools: null }[]).map((e) => {
			expect(e.tools).toBeNull();
			return (
				db.prepare('SELECT name FROM mcp_servers WHERE id = ?').get(e.serverId) as {
					name: string;
				}
			).name;
		});
		expect(names).toEqual(expect.arrayContaining(['chat-search', 'memory', 'webfetch']));
		expect(names).not.toContain('fs');
		expect(names).not.toContain('agents');
		expect(access('k2')).toBe(explicit);
		db.close();
	});
});
