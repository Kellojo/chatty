import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePatch } from 'diff';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.MEMORY_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-mem-'));

const { getDb } = await import('../db/index.js');
const bundle = await import('./bundle.js');
const fts = await import('./fts.js');
const paths = await import('./paths.js');
const writes = await import('../db/repo/memory-writes.js');

const audit = { author: 'user:u1', userId: 'u1' };

function conceptAbs(userId: string, relPath: string): string {
	return path.join(paths.bundleDir('user', userId), ...relPath.split('/'));
}

describe('memory bundle', () => {
	let db: ReturnType<typeof getDb>;

	beforeAll(() => {
		db = getDb();
	});

	it('writeConcept creates the file, audit row and FTS entry', async () => {
		const concept = await bundle.writeConcept(
			db,
			'user',
			'u1',
			'people/john.md',
			{
				frontmatter: { title: 'John', description: 'A person', tags: ['friend', 'colleague'] },
				body: 'John likes espresso.'
			},
			audit
		);
		expect(concept.path).toBe('people/john.md');
		expect(concept.frontmatter.type).toBe('concept');
		expect(concept.frontmatter.title).toBe('John');
		expect(fs.existsSync(conceptAbs('u1', 'people/john.md'))).toBe(true);

		const rows = writes.listMemoryWrites(db, { userId: 'u1', conceptPath: 'people/john.md' });
		expect(rows).toHaveLength(1);
		expect(rows[0].action).toBe('create');
		expect(rows[0].author).toBe('user:u1');
		expect(rows[0].diff).toBeTruthy();

		const hits = fts.searchMemoryFts(db, ['user:u1'], 'espresso');
		expect(hits).toHaveLength(1);
		expect(hits[0].path).toBe('people/john.md');
		expect(hits[0].scope).toBe('user:u1');
		const tagHits = fts.searchMemoryFts(db, ['user:u1'], 'colleague');
		expect(tagHits.map((h) => h.path)).toContain('people/john.md');
	});

	it('readConcept returns what was written', async () => {
		const concept = await bundle.readConcept('user', 'u1', 'people/john.md');
		expect(concept).not.toBeNull();
		expect(concept!.frontmatter.title).toBe('John');
		expect(concept!.frontmatter.description).toBe('A person');
		expect(concept!.frontmatter.tags).toEqual(['friend', 'colleague']);
		expect(concept!.frontmatter.timestamp).toBeTruthy();
		expect(concept!.body.trim()).toBe('John likes espresso.');
	});

	it('readConcept returns null for missing or invalid paths', async () => {
		expect(await bundle.readConcept('user', 'u1', 'missing.md')).toBeNull();
		expect(await bundle.readConcept('user', 'u1', '../x.md')).toBeNull();
	});

	it('update produces an update row with a parseable diff', async () => {
		await bundle.writeConcept(
			db,
			'user',
			'u1',
			'people/john.md',
			{
				frontmatter: { title: 'John', description: 'A person', tags: ['friend'] },
				body: 'John likes espresso and runs marathons.'
			},
			audit
		);
		const rows = writes.listMemoryWrites(db, { userId: 'u1', conceptPath: 'people/john.md' });
		expect(rows).toHaveLength(2);
		expect(rows[0].action).toBe('update');
		const patches = parsePatch(rows[0].diff!);
		expect(patches).toHaveLength(1);
		expect(rows[0].diff).toContain('-John likes espresso.');
		expect(rows[0].diff).toContain('+John likes espresso and runs marathons.');
	});

	it('index.md lists child concept titles', async () => {
		await bundle.flushMemoryIndexes();
		const indexAbs = path.join(paths.bundleDir('user', 'u1'), 'people', 'index.md');
		expect(fs.existsSync(indexAbs)).toBe(true);
		const content = fs.readFileSync(indexAbs, 'utf8');
		expect(content).toContain('# Index');
		expect(content).toContain('- [John](john.md) — A person');
	});

	it('listTree nests dirs and concepts with titles', async () => {
		const tree = await bundle.listTree('user', 'u1');
		const people = tree.find((n) => n.name === 'people');
		expect(people?.kind).toBe('dir');
		const john = people?.children?.find((n) => n.name === 'john.md');
		expect(john?.kind).toBe('concept');
		expect(john?.title).toBe('John');
		expect(john?.description).toBe('A person');
		expect(tree.some((n) => n.name === 'index.md')).toBe(false);
	});

	it('listConceptPaths returns flat paths with optional prefix', async () => {
		expect(await bundle.listConceptPaths('user', 'u1')).toEqual(['people/john.md']);
		expect(await bundle.listConceptPaths('user', 'u1', 'people')).toEqual(['people/john.md']);
		expect(await bundle.listConceptPaths('user', 'u1', 'nope')).toEqual([]);
		expect(await bundle.listConceptPaths('user', 'u1', '../')).toEqual([]);
	});

	it('moveConcept relocates the file and records a rename diff', async () => {
		const moved = await bundle.moveConcept(
			db,
			'user',
			'u1',
			'people/john.md',
			'people/jonathan.md',
			audit
		);
		expect(moved.path).toBe('people/jonathan.md');
		expect(fs.existsSync(conceptAbs('u1', 'people/john.md'))).toBe(false);
		expect(fs.existsSync(conceptAbs('u1', 'people/jonathan.md'))).toBe(true);

		const rows = writes.listMemoryWrites(db, { userId: 'u1', conceptPath: 'people/jonathan.md' });
		expect(rows).toHaveLength(1);
		expect(rows[0].action).toBe('update');
		expect(rows[0].diff).toContain('a/people/john.md');
		expect(rows[0].diff).toContain('b/people/jonathan.md');

		expect(fts.searchMemoryFts(db, ['user:u1'], 'marathons').map((h) => h.path)).toEqual([
			'people/jonathan.md'
		]);
		await bundle.flushMemoryIndexes();
		const indexContent = fs.readFileSync(
			path.join(paths.bundleDir('user', 'u1'), 'people', 'index.md'),
			'utf8'
		);
		expect(indexContent).toContain('- [John](jonathan.md) — A person');
	});

	it('moveConcept throws when source is missing or target exists', async () => {
		await expect(
			bundle.moveConcept(db, 'user', 'u1', 'missing.md', 'other.md', audit)
		).rejects.toThrow(/not found/i);
		await expect(
			bundle.moveConcept(db, 'user', 'u1', 'people/jonathan.md', 'people/jonathan.md', audit)
		).rejects.toThrow(/already exists/i);
	});

	it('deleteConcept removes file, FTS row and index.md', async () => {
		const ok = await bundle.deleteConcept(db, 'user', 'u1', 'people/jonathan.md', audit);
		expect(ok).toBe(true);
		expect(await bundle.deleteConcept(db, 'user', 'u1', 'people/jonathan.md', audit)).toBe(false);
		expect(fs.existsSync(conceptAbs('u1', 'people/jonathan.md'))).toBe(false);
		expect(fts.searchMemoryFts(db, ['user:u1'], 'marathons')).toEqual([]);
		expect(fs.existsSync(path.join(paths.bundleDir('user', 'u1'), 'people', 'index.md'))).toBe(
			false
		);
		expect(fs.existsSync(path.join(paths.bundleDir('user', 'u1'), 'people'))).toBe(false);
		const rows = writes.listMemoryWrites(db, { userId: 'u1', conceptPath: 'people/jonathan.md' });
		expect(rows[0].action).toBe('delete');
		expect(rows[0].diff).toContain('-John likes espresso and runs marathons.');
	});

	it('deleteConcept publishes a memory.changed event with action delete', async () => {
		const { subscribeServerEvents } = await import('../events/bus.js');
		await bundle.writeConcept(
			db,
			'user',
			'u1',
			'events/victim.md',
			{ frontmatter: { title: 'Victim' }, body: 'Soon to be deleted.' },
			audit
		);
		const seen: unknown[] = [];
		const unsub = subscribeServerEvents('u1', (_userId, event) => {
			if (event.type === 'memory.changed') seen.push(event);
		});
		try {
			await bundle.deleteConcept(db, 'user', 'u1', 'events/victim.md', audit);
		} finally {
			unsub();
		}
		expect(seen).toContainEqual({
			type: 'memory.changed',
			scope: 'user',
			path: 'events/victim.md',
			action: 'delete',
			author: 'user:u1'
		});
	});

	it('deleteConcept prunes the now-empty directory chain', async () => {
		await bundle.writeConcept(
			db,
			'user',
			'u1',
			'deep/nested/thing.md',
			{ frontmatter: { title: 'Thing' }, body: 'A nested thing.' },
			audit
		);
		expect(fs.existsSync(conceptAbs('u1', 'deep/nested/thing.md'))).toBe(true);

		await bundle.deleteConcept(db, 'user', 'u1', 'deep/nested/thing.md', audit);
		expect(fs.existsSync(conceptAbs('u1', 'deep/nested/thing.md'))).toBe(false);
		expect(fs.existsSync(path.join(paths.bundleDir('user', 'u1'), 'deep'))).toBe(false);
	});

	it('moveConcept prunes the emptied source directory', async () => {
		await bundle.writeConcept(
			db,
			'user',
			'u1',
			'oldhome/note.md',
			{ frontmatter: { title: 'Note' }, body: 'A movable note.' },
			audit
		);
		const moved = await bundle.moveConcept(
			db,
			'user',
			'u1',
			'oldhome/note.md',
			'newhome/note.md',
			audit
		);
		expect(moved.path).toBe('newhome/note.md');
		expect(fs.existsSync(conceptAbs('u1', 'newhome/note.md'))).toBe(true);
		expect(fs.existsSync(path.join(paths.bundleDir('user', 'u1'), 'oldhome'))).toBe(false);

		await bundle.deleteConcept(db, 'user', 'u1', 'newhome/note.md', audit);
		expect(fs.existsSync(path.join(paths.bundleDir('user', 'u1'), 'newhome'))).toBe(false);
	});

	it('serializes concurrent writes so each diff sees the previous content', async () => {
		const write = (body: string) =>
			bundle.writeConcept(
				db,
				'user',
				'u1',
				'race/note.md',
				{ frontmatter: { title: 'Race' }, body },
				audit
			);
		await Promise.all([write('first'), write('second')]);
		const rows = writes.listMemoryWrites(db, { userId: 'u1', conceptPath: 'race/note.md' });
		expect(rows.map((r) => r.action).sort()).toEqual(['create', 'update']);
		await bundle.deleteConcept(db, 'user', 'u1', 'race/note.md', audit);
	});

	it('shared scope audit rows use actor id and shared/ prefix', async () => {
		await bundle.writeConcept(
			db,
			'shared',
			'u1',
			'glossary.md',
			{ frontmatter: { title: 'Glossary' }, body: 'Shared terms.' },
			{ author: 'agent:a1', userId: 'u2' }
		);
		const rows = writes.listMemoryWrites(db, { conceptPath: 'shared/glossary.md' });
		expect(rows).toHaveLength(1);
		expect(rows[0].user_id).toBe('u2');
		expect(rows[0].author).toBe('agent:a1');
		expect(fts.searchMemoryFts(db, ['shared'], 'terms').map((h) => h.scope)).toEqual(['shared']);
	});

	it('rejects invalid frontmatter input', async () => {
		await expect(
			bundle.writeConcept(
				db,
				'user',
				'u1',
				'bad.md',
				{ frontmatter: { title: '' }, body: 'x' },
				audit
			)
		).rejects.toThrow(/frontmatter/i);
		await expect(
			bundle.writeConcept(
				db,
				'user',
				'u1',
				'bad.md',
				{ frontmatter: { title: 'Ok', tags: Array(21).fill('t') }, body: 'x' },
				audit
			)
		).rejects.toThrow(/frontmatter/i);
	});

	it('rejects invalid concept paths', async () => {
		await expect(
			bundle.writeConcept(
				db,
				'user',
				'u1',
				'../evil.md',
				{ frontmatter: { title: 'X' }, body: 'x' },
				audit
			)
		).rejects.toThrow(/invalid concept path/i);
		await expect(bundle.deleteConcept(db, 'user', 'u1', 'index.md', audit)).rejects.toThrow(
			/invalid concept path/i
		);
	});
});
