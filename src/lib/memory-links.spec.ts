import { describe, expect, it } from 'vitest';
import { markMemoryLinksRelative, resolveMemoryLink } from './memory-links.js';

describe('markMemoryLinksRelative', () => {
	it('prefixes bare memory paths with ./', () => {
		expect(markMemoryLinksRelative('See [A](science/a.md) and [B](b.md#top).')).toBe(
			'See [A](./science/a.md) and [B](./b.md#top).'
		);
	});

	it('keeps a link title', () => {
		expect(markMemoryLinksRelative('[A](a.md "Title")')).toBe('[A](./a.md "Title")');
	});

	it('leaves URLs, explicit relative paths and non-memory links alone', () => {
		const text =
			'[w](https://x.com/a.md) [r](./a.md) [u](../a.md) [s](/a.md) [h](#a) [p](notes.txt)';
		expect(markMemoryLinksRelative(text)).toBe(text);
	});
});

describe('resolveMemoryLink', () => {
	const known = new Set(['science/a.md', 'science/b.md', 'astro/c.md', 'top.md']);

	it('resolves relative to the memory first, then from the bundle root', () => {
		expect(resolveMemoryLink('science/a.md', './b.md', known)).toBe('science/b.md');
		expect(resolveMemoryLink('science/a.md', './astro/c.md', known)).toBe('astro/c.md');
		expect(resolveMemoryLink('science/a.md', '../top.md', known)).toBe('top.md');
		expect(resolveMemoryLink('science/a.md', 'b.md#section', known)).toBe('science/b.md');
	});

	it('returns null for unknown targets, self links and URLs', () => {
		expect(resolveMemoryLink('science/a.md', './gone.md', known)).toBeNull();
		expect(resolveMemoryLink('science/a.md', './a.md', known)).toBeNull();
		expect(resolveMemoryLink('science/a.md', 'https://x.com/b.md', known)).toBeNull();
		expect(resolveMemoryLink('science/a.md', '%E0%A4%A.md', known)).toBeNull();
	});
});
