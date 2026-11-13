import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.MEMORY_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-mem-fts-'));

const { getDb } = await import('../db/index.js');
const fts = await import('./fts.js');
const paths = await import('./paths.js');

function writeExternal(userDir: string, relPath: string, title: string, body: string): void {
	const abs = path.join(paths.memoryRoot(), userDir, ...relPath.split('/'));
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, matter.stringify(body, { title, tags: ['external'] }));
}

describe('memory fts', () => {
	let db: ReturnType<typeof getDb>;

	beforeAll(() => {
		db = getDb();
	});

	it('reconcile picks up external files and drops stale rows', () => {
		writeExternal('u1', 'notes/todo.md', 'Todo', 'buy oat milk');
		writeExternal('shared', 'glossary.md', 'Glossary', 'shared terms');
		fts.upsertMemoryFts(
			db,
			'user:ghost',
			'gone.md',
			{ title: 'Ghost', description: '', tags: [] },
			'stale body'
		);

		const result = fts.reconcileMemoryFts(db);
		expect(result.upserted).toBe(2);
		expect(result.removed).toBe(1);

		const hits = fts.searchMemoryFts(db, ['user:u1'], 'oat');
		expect(hits.map((h) => h.path)).toEqual(['notes/todo.md']);
		expect(hits[0].title).toBe('Todo');
		expect(hits[0].tags).toEqual(['external']);
		expect(hits[0].snippet).toContain('<mark>');
		expect(fts.searchMemoryFts(db, ['shared'], 'terms').map((h) => h.path)).toEqual([
			'glossary.md'
		]);
		expect(fts.searchMemoryFts(db, ['user:ghost'], 'stale')).toEqual([]);
	});

	it('reconcile removes rows for deleted files', () => {
		fs.unlinkSync(path.join(paths.memoryRoot(), 'u1', 'notes', 'todo.md'));
		const result = fts.reconcileMemoryFts(db);
		expect(result.removed).toBe(1);
		expect(fts.searchMemoryFts(db, ['user:u1'], 'oat')).toEqual([]);
	});

	it('reindex rebuilds the table and returns the count', () => {
		writeExternal('u2', 'a.md', 'Alpha', 'alpha body');
		const result = fts.reindexMemoryFts(db);
		expect(result.indexed).toBe(2);
		expect(fts.searchMemoryFts(db, ['user:u2'], 'alpha').map((h) => h.path)).toEqual(['a.md']);
		expect(fts.searchMemoryFts(db, ['shared'], 'terms').map((h) => h.path)).toEqual([
			'glossary.md'
		]);
	});

	it('tolerates files with invalid frontmatter', () => {
		const abs = path.join(paths.memoryRoot(), 'u1', 'broken.md');
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, '---\ntitle: [unclosed\n---\nbody text here');
		const result = fts.reindexMemoryFts(db);
		expect(result.indexed).toBe(3);
	});

	it('sanitizes weird queries without throwing', () => {
		expect(fts.searchMemoryFts(db, ['user:u1'], '"""')).toEqual([]);
		expect(fts.searchMemoryFts(db, ['user:u1'], '!!!')).toEqual([]);
		expect(fts.searchMemoryFts(db, ['user:u1'], '')).toEqual([]);
		expect(fts.searchMemoryFts(db, [], 'alpha')).toEqual([]);
		expect(Array.isArray(fts.searchMemoryFts(db, ['user:u2'], 'alpha OR "unterminated'))).toBe(
			true
		);
	});

	it('stems words and folds diacritics', () => {
		fts.upsertMemoryFts(
			db,
			'user:stem',
			't.md',
			{ title: 'Timesheet', description: '', tags: [] },
			'Tracking worked hours in the Grösse table'
		);
		const find = (q: string) => fts.searchMemoryFts(db, ['user:stem'], q).map((h) => h.path);
		expect(find('tracker hour')).toEqual(['t.md']);
		expect(find('grosse')).toEqual(['t.md']);
	});

	it('keeps hyphenated words together as a phrase', () => {
		const tags: string[] = [];
		fts.upsertMemoryFts(db, 'user:ph', 'a.md', { title: 'A', description: '', tags }, 'pocket id');
		fts.upsertMemoryFts(db, 'user:ph', 'b.md', { title: 'B', description: '', tags }, 'id pocket');
		expect(fts.searchMemoryFts(db, ['user:ph'], 'Pocket-ID').map((h) => h.path)).toEqual(['a.md']);
	});

	it('ranks title matches above body matches', () => {
		const tags: string[] = [];
		fts.upsertMemoryFts(
			db,
			'user:rank',
			'body.md',
			{ title: 'Notes', description: '', tags },
			'a long note that mentions kubernetes once among plenty of other words'
		);
		fts.upsertMemoryFts(
			db,
			'user:rank',
			'title.md',
			{ title: 'Kubernetes', description: '', tags },
			'a long note about cluster setup with plenty of other words in it'
		);
		const hits = fts.searchMemoryFts(db, ['user:rank'], 'kubernetes');
		expect(hits.map((h) => h.path)).toEqual(['title.md', 'body.md']);
	});

	it('scopes search results', () => {
		expect(fts.searchMemoryFts(db, ['user:u1'], 'alpha')).toEqual([]);
		expect(fts.searchMemoryFts(db, ['user:u2', 'shared'], 'alpha')).toHaveLength(1);
	});

	it('HTML-escapes snippets on request, keeping only the highlight markup', () => {
		fts.upsertMemoryFts(
			db,
			'user:xss',
			'x.md',
			{ title: 'X', description: '', tags: [] },
			'payload <img src=x onerror="alert(1)"> zebra'
		);
		const [html] = fts.searchMemoryFts(db, ['user:xss'], 'zebra', 10, { html: true });
		expect(html.snippet).not.toContain('<img');
		expect(html.snippet).toContain('&#60;img');
		expect(html.snippet).toContain('<mark>zebra</mark>');
		const [text] = fts.searchMemoryFts(db, ['user:xss'], 'zebra');
		expect(text.snippet).toContain('<img');
		expect(text.snippet).toContain('<mark>zebra</mark>');
	});
});
