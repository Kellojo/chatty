import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './index.js';

describe('db migrations', () => {
	it('applies all migrations on a fresh database', () => {
		const db = openDatabase(':memory:');
		const tables = (
			db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
				.all() as { name: string }[]
		).map((r) => r.name);
		for (const expected of [
			'user',
			'session',
			'account',
			'verification',
			'conversations',
			'messages',
			'agents',
			'agent_runs',
			'memory_writes',
			'api_keys',
			'providers',
			'models',
			'mcp_servers',
			'settings',
			'skill_invocations',
			'attachments',
			'messages_fts',
			'user_settings',
			'memory_fts',
			'documents_fts',
			'agent_user_overrides',
			'agent_event_counters',
			'model_mappings',
			'proxy_requests',
			'conversation_summaries',
			'coding_environments',
			'coding_usage_limits',
			'coding_usage_daily'
		]) {
			expect(tables).toContain(expected);
		}
		const versions = db.prepare('SELECT version FROM _migrations ORDER BY version').all() as {
			version: number;
		}[];
		// Numbers can have gaps (e.g. one reserved by unmerged work), so derive them.
		const expectedVersions = readdirSync(join(process.cwd(), 'migrations'))
			.filter((f) => /^\d{4}_.*\.sql$/.test(f))
			.map((f) => Number(f.slice(0, 4)))
			.sort((a, b) => a - b);
		expect(versions.map((v) => v.version)).toEqual(expectedVersions);
		db.close();
	});

	it('is idempotent on reopen', () => {
		const db = openDatabase(':memory:');
		expect(() => openDatabase(':memory:')).not.toThrow();
		db.close();
	});

	it('keeps messages_fts in sync via triggers', () => {
		const db = openDatabase(':memory:');
		db.prepare(
			"INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')"
		).run();
		db.prepare(
			"INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES ('c1', 'u1', 't', 0, 0)"
		).run();
		db.prepare(
			"INSERT INTO messages (id, conversation_id, role, parts, content_text, created_at) VALUES ('m1', 'c1', 'user', '[]', 'hello world', 0)"
		).run();
		const hit = db
			.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')
			.get('hello');
		expect(hit).toBeTruthy();
		db.prepare("UPDATE messages SET content_text = 'goodbye' WHERE id = 'm1'").run();
		expect(
			db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').get('hello')
		).toBeUndefined();
		expect(
			db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').get('goodbye')
		).toBeTruthy();
		db.prepare("DELETE FROM messages WHERE id = 'm1'").run();
		expect(
			db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').get('goodbye')
		).toBeUndefined();
		db.close();
	});
});
