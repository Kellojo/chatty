import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrate.js';

const MIGRATION = '0049_merged_tool_allowlists.sql';
const source = path.join(process.cwd(), 'migrations');
let dir: string | null = null;

afterEach(async () => {
	if (dir) await fs.rm(dir, { recursive: true, force: true });
	dir = null;
});

describe('0049_merged_tool_allowlists', () => {
	it('rewrites allowlists that name merged tools and leaves the rest alone', async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatty-migrations-'));
		for (const file of await fs.readdir(source)) {
			if (file.endsWith('.sql') && file < MIGRATION) {
				await fs.copyFile(path.join(source, file), path.join(dir, file));
			}
		}
		const db = new Database(':memory:');
		migrate(db, dir);
		const insert = db.prepare(
			`INSERT INTO agents (id, user_id, name, system_prompt, tool_allowlist, trigger_type, created_at, updated_at)
			 VALUES (?, NULL, ?, '', ?, 'manual', 0, 0)`
		);
		insert.run('a1', 'math', JSON.stringify(['add', 'multiply', 'mean', 'now']));
		insert.run('a2', 'fs', JSON.stringify(['fs_head', 'fs_wc', 'fs_read', 'fs_ls']));
		insert.run('a3', 'other', JSON.stringify(['now', 'fetch']));
		insert.run('a4', 'all', null);

		await fs.copyFile(path.join(source, MIGRATION), path.join(dir, MIGRATION));
		migrate(db, dir);

		const allowlist = (id: string) => {
			const row = db.prepare('SELECT tool_allowlist FROM agents WHERE id = ?').get(id) as {
				tool_allowlist: string | null;
			};
			return row.tool_allowlist === null
				? null
				: (JSON.parse(row.tool_allowlist) as string[]).sort();
		};
		expect(allowlist('a1')).toEqual(['calculate', 'now', 'statistics']);
		expect(allowlist('a2')).toEqual(['fs_ls', 'fs_read']);
		expect(allowlist('a3')).toEqual(['fetch', 'now']);
		expect(allowlist('a4')).toBeNull();
		db.close();
	});
});
