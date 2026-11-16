import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.MEMORY_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-mem-private-'));

const { getDb } = await import('../db/index.js');
const bundle = await import('./bundle.js');
const fts = await import('./fts.js');
const graph = await import('./graph.js');
const paths = await import('./paths.js');
const { conceptIsPrivate, rawConceptIsPrivate } = await import('./private.js');

const audit = { author: 'user:p1', userId: 'p1' };
const ALL = { includePrivate: true };
const PUBLIC = { includePrivate: false };

function rawFile(userId: string, relPath: string): string {
	return fs.readFileSync(path.join(paths.bundleDir('user', userId), ...relPath.split('/')), 'utf8');
}

const write = (
	userId: string,
	relPath: string,
	fm: { title: string; private?: boolean; tags?: string[] },
	body: string
) => bundle.writeConcept(getDb(), 'user', userId, relPath, { frontmatter: fm, body }, audit);

describe('private concepts: frontmatter round trip', () => {
	let db: ReturnType<typeof getDb>;
	beforeAll(() => {
		db = getDb();
	});

	it('writes, reads and keeps the flag through saves, moves and a reindex', async () => {
		const saved = await write(
			'p1',
			'health/meds.md',
			{ title: 'Meds', private: true },
			'ibuprofen'
		);
		expect(saved.frontmatter.private).toBe(true);
		expect(rawFile('p1', 'health/meds.md')).toMatch(/^private: true$/m);
		expect((await bundle.readConcept('user', 'p1', 'health/meds.md'))?.frontmatter.private).toBe(
			true
		);

		// A save that doesn't mention the flag keeps it.
		await write('p1', 'health/meds.md', { title: 'Meds v2' }, 'ibuprofen 400');
		expect((await bundle.readConcept('user', 'p1', 'health/meds.md'))?.frontmatter.private).toBe(
			true
		);

		const moved = await bundle.moveConcept(db, 'user', 'p1', 'health/meds.md', 'h/m.md', audit);
		expect(moved.frontmatter.private).toBe(true);
		expect(fts.memorySummaries(db, 'user:p1', ALL).get('h/m.md')?.private).toBe(true);
		expect(fts.memorySummaries(db, 'user:p1', PUBLIC).has('h/m.md')).toBe(false);

		await fts.reindexMemoryFts(db);
		expect(fts.memorySummaries(db, 'user:p1', ALL).get('h/m.md')?.private).toBe(true);
		expect(fts.searchMemoryFts(db, ['user:p1'], 'ibuprofen', 10, PUBLIC)).toEqual([]);

		// Only an explicit false clears it, and public files carry no flag at all.
		await write('p1', 'h/m.md', { title: 'Meds', private: false }, 'ibuprofen');
		expect(rawFile('p1', 'h/m.md')).not.toMatch(/private/);
		expect((await bundle.readConcept('user', 'p1', 'h/m.md'))?.frontmatter.private).toBeUndefined();
	});

	it('marks a whole folder private', async () => {
		await write('p2', 'fin/a.md', { title: 'A' }, 'alpha');
		await write('p2', 'fin/deep/b.md', { title: 'B' }, 'beta');
		await write('p2', 'other.md', { title: 'O' }, 'omega');
		const n = await bundle.setConceptsPrivate(db, 'user', 'p2', 'fin', true, audit);
		expect(n).toBe(2);
		expect(await bundle.setConceptsPrivate(db, 'user', 'p2', 'fin', true, audit)).toBe(0);
		const tree = await bundle.listTree('user', 'p2');
		const fin = tree.find((t) => t.name === 'fin');
		expect(fin?.children?.find((c) => c.name === 'a.md')?.private).toBe(true);
		expect(tree.find((t) => t.name === 'other.md')?.private).toBeUndefined();
	});

	it('fails closed on a file whose frontmatter is broken', () => {
		const raw = '---\ntitle: [unclosed\nprivate: true\n---\nsecret';
		expect(rawConceptIsPrivate(raw)).toBe(true);
		expect(conceptIsPrivate(null, raw)).toBe(true);
		expect(rawConceptIsPrivate('---\ntitle: ok\n---\nprivate: true is just text')).toBe(false);
	});
});

describe('private concepts: search', () => {
	it('drops private concepts before ranking and LIMIT, and counts them', async () => {
		const db = getDb();
		for (let i = 0; i < 3; i++) {
			await write('s1', `p${i}.md`, { title: `kumquat ${i}`, private: true }, 'kumquat kumquat');
		}
		await write('s1', 'pub.md', { title: 'note' }, 'one kumquat');
		const pub = fts.searchMemoryFts(db, ['user:s1'], 'kumquat', 1, PUBLIC);
		expect(pub.map((h) => h.path)).toEqual(['pub.md']);
		expect(fts.countPrivateMemoryHits(db, ['user:s1'], 'kumquat')).toBe(3);
		const all = fts.searchMemoryFts(db, ['user:s1'], 'kumquat', 10, ALL);
		expect(all).toHaveLength(4);
		expect(all.filter((h) => h.private)).toHaveLength(3);
		const only = fts.searchMemoryFts(db, ['user:s1'], 'kumquat', 10, {
			includePrivate: true,
			privateOnly: true
		});
		expect(only.every((h) => h.private)).toBe(true);
		expect(only).toHaveLength(3);
	});

	it('leaves private concepts and their links out of a filtered graph', async () => {
		await write('g1', 'a.md', { title: 'A' }, 'see [b](b.md)');
		await write('g1', 'b.md', { title: 'B', private: true }, 'secret');
		const filtered = await graph.buildMemoryGraph(['user'], 'g1', PUBLIC);
		expect(filtered.nodes.map((n) => n.path)).toEqual(['a.md']);
		expect(filtered.edges).toEqual([]);
		const full = await graph.buildMemoryGraph(['user'], 'g1', ALL);
		expect(full.nodes.find((n) => n.path === 'b.md')?.private).toBe(true);
		expect(full.edges).toHaveLength(1);
	});
});
