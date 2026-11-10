import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
const volume = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-mem-graph-'));
process.env.MEMORY_VOLUME = volume;

const { buildMemoryGraph, resolveLink } = await import('./graph.js');

function write(rel: string, frontmatter: string, body: string) {
	const abs = path.join(volume, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, frontmatter ? ['---', frontmatter, '---', body].join('\n') : body);
}

describe('resolveLink', () => {
	const known = new Set(['a/x.md', 'a/y.md', 'b/z.md']);
	it('resolves relative to the file, then to the bundle root', () => {
		expect(resolveLink('a/x.md', 'y.md', known)).toBe('a/y.md');
		expect(resolveLink('a/x.md', 'b/z.md', known)).toBe('b/z.md');
		expect(resolveLink('a/x.md', '../b/z.md', known)).toBe('b/z.md');
	});
	it('ignores self links, URLs and unknown targets', () => {
		expect(resolveLink('a/x.md', 'x.md', known)).toBeNull();
		expect(resolveLink('a/x.md', 'https://e.com/y.md', known)).toBeNull();
		expect(resolveLink('a/x.md', 'nope.md', known)).toBeNull();
	});
});

describe('buildMemoryGraph', () => {
	it('builds nodes, link edges and tag edges without duplicates', async () => {
		write(
			'u1/a/x.md',
			'title: X\ntags: [Space, rare]',
			'See [Y](y.md) and [Z](b/z.md), again [Y](y.md).'
		);
		write('u1/a/y.md', 'title: Y\ntags: [space]', 'Back to [X](x.md).');
		write('u1/b/z.md', 'title: Z\ntags: [rare]', 'No links.');
		write('u1/c/w.md', 'title: W\ntags: [space]', 'Unlinked.');
		write('u1/a/index.md', '', '- [X](x.md)');
		const graph = await buildMemoryGraph(['user'], 'u1');
		expect(graph.nodes.map((n) => n.id)).toEqual([
			'user:a/x.md',
			'user:a/y.md',
			'user:b/z.md',
			'user:c/w.md'
		]);
		expect(graph.nodes[0]).toMatchObject({
			scope: 'user',
			path: 'a/x.md',
			title: 'X',
			folder: 'a',
			tags: ['space', 'rare']
		});
		expect(graph.edges).toEqual([
			{ source: 'user:a/x.md', target: 'user:a/y.md', kind: 'link' },
			{ source: 'user:a/x.md', target: 'user:b/z.md', kind: 'link' },
			// Shared tag `space`; x–y is skipped because they're already linked.
			{ source: 'user:a/x.md', target: 'user:c/w.md', kind: 'tag' },
			{ source: 'user:a/y.md', target: 'user:c/w.md', kind: 'tag' }
		]);
	});

	it('groups shared memories and connects them to the user by tag', async () => {
		write('u2/mine.md', 'title: Mine\ntags: [cats]', 'Body.');
		write('shared/team/cats.md', 'title: Cats\ntags: [cats]', 'Body.');
		const graph = await buildMemoryGraph(['user', 'shared'], 'u2');
		expect(graph.nodes.map((n) => [n.id, n.folder])).toEqual([
			['user:mine.md', ''],
			['shared:team/cats.md', 'Shared']
		]);
		expect(graph.edges).toEqual([
			{ source: 'user:mine.md', target: 'shared:team/cats.md', kind: 'tag' }
		]);
	});

	it('returns an empty graph for a missing bundle', async () => {
		expect(await buildMemoryGraph(['user'], 'nobody')).toEqual({ nodes: [], edges: [] });
	});
});
