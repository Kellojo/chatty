import { describe, expect, it } from 'vitest';
import { indexSources, sourceKey } from './source-cards.js';

const toolPart = (output: unknown) => ({ type: 'tool-fetch', state: 'output-available', output });

describe('sourceKey', () => {
	it('treats http/https, www., fragments and trailing slashes as the same page', () => {
		expect(sourceKey('http://www.Example.com/a/#top')).toBe('https://example.com/a');
		expect(sourceKey('https://example.com/a?x=1')).toBe('https://example.com/a?x=1');
		expect(sourceKey('javascript:alert(1)')).toBeNull();
		expect(sourceKey('not a url')).toBeNull();
	});
});

describe('indexSources', () => {
	it('collects cards from structuredContent and URLs from the text the model saw', () => {
		const index = indexSources([
			{ parts: [{ type: 'text', text: 'see https://ignored.example/user-text' }] },
			{
				parts: [
					toolPart({
						content: [{ type: 'text', text: 'Read more at https://linked.example/page.' }],
						structuredContent: {
							sources: [{ url: 'https://www.songkick.com/a/', title: 'Lane 8', favicon: 'f' }, 'x']
						}
					})
				]
			}
		]);
		expect(index.cards.get('https://songkick.com/a')).toEqual({
			url: 'https://www.songkick.com/a/',
			title: 'Lane 8',
			favicon: 'f'
		});
		expect(index.seen.has('https://linked.example/page')).toBe(true);
		// Only tool results count, not what the user or model wrote.
		expect(index.seen.has('https://ignored.example/user-text')).toBe(false);
	});

	it('reads the cards older replies put in the text: fetch parts and search lines', () => {
		const index = indexSources([
			{
				parts: [
					toolPart({
						content: [
							{ type: 'text', text: 'page body' },
							{ type: 'text', text: 'Source card: {"url":"https://a.example/","title":"A"}' }
						]
					}),
					toolPart({
						content: [
							{
								type: 'text',
								text: 'Results for "q" via SearXNG:\n[1] {"url":"https://b.example/x","title":"B"} (published 2026-01-01)'
							}
						]
					})
				]
			}
		]);
		expect(index.cards.get('https://a.example')?.title).toBe('A');
		expect(index.cards.get('https://b.example/x')?.title).toBe('B');
	});

	it('keeps the first card of a page and fills in only what it lacks', () => {
		const index = indexSources([
			{
				parts: [
					toolPart({
						content: [],
						structuredContent: { sources: [{ url: 'https://a.example', title: 'First' }] }
					}),
					toolPart({
						content: [],
						structuredContent: {
							sources: [{ url: 'https://a.example/', title: 'Second', site: 'A site' }]
						}
					})
				]
			}
		]);
		expect(index.cards.get('https://a.example')).toEqual({
			url: 'https://a.example',
			title: 'First',
			site: 'A site'
		});
	});
});
