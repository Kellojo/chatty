import { describe, expect, it, vi } from 'vitest';
import {
	createCachedCodePlugin,
	createTokenCache,
	type SharedHighlighter
} from './code-highlight.js';

const light = { name: 'light' };
const dark = { name: 'dark' };

function fakeHighlighter(ready = true) {
	let isReady = ready;
	const highlighter = {
		isReady: vi.fn(() => isReady),
		load: vi.fn(async () => {
			isReady = true;
		}),
		highlightCode: vi.fn((code: string, language: string, theme: string) =>
			code.split('\n').map((line) => [{ content: line, color: `${theme}:${language}` }])
		)
	} satisfies SharedHighlighter;
	return highlighter;
}

const options = (code: string, activeTheme = light, language = 'ts') => ({
	code,
	language,
	themes: [activeTheme, activeTheme] as [typeof light, typeof light],
	activeTheme
});

describe('createCachedCodePlugin', () => {
	it('tokenizes a block once and reuses the result', () => {
		const highlighter = fakeHighlighter();
		const plugin = createCachedCodePlugin(
			() => highlighter,
			() => [light, light]
		);
		const first = plugin.highlight(options('const a = 1;'));
		const second = plugin.highlight(options('const a = 1;'));
		expect(first?.tokens).toEqual([[{ content: 'const a = 1;', color: 'light:ts' }]]);
		expect(second).toBe(first);
		expect(highlighter.highlightCode).toHaveBeenCalledTimes(1);
	});

	it('keys the cache by theme and language', () => {
		const highlighter = fakeHighlighter();
		const plugin = createCachedCodePlugin(
			() => highlighter,
			() => [light, light]
		);
		plugin.highlight(options('x'));
		const darkResult = plugin.highlight(options('x', dark));
		const pyResult = plugin.highlight(options('x', light, 'py'));
		expect(darkResult?.tokens[0][0].color).toBe('dark:ts');
		expect(pyResult?.tokens[0][0].color).toBe('light:py');
		expect(highlighter.highlightCode).toHaveBeenCalledTimes(3);
	});

	it('highlights a changed (streaming) block again', () => {
		const highlighter = fakeHighlighter();
		const plugin = createCachedCodePlugin(
			() => highlighter,
			() => [light, light]
		);
		plugin.highlight(options('const'));
		const grown = plugin.highlight(options('const a'));
		expect(grown?.tokens[0][0].content).toBe('const a');
	});

	it('loads the language first and hands the tokens to the callback', async () => {
		const highlighter = fakeHighlighter(false);
		const plugin = createCachedCodePlugin(
			() => highlighter,
			() => [light, light]
		);
		const callback = vi.fn();
		expect(plugin.highlight(options('a'), callback)).toBeNull();
		await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
		expect(highlighter.load).toHaveBeenCalledWith('light', 'ts');
		expect(callback.mock.calls[0][0].tokens[0][0].content).toBe('a');
	});

	it('falls back to the first theme without an active theme', () => {
		const highlighter = fakeHighlighter();
		const plugin = createCachedCodePlugin(
			() => highlighter,
			() => [dark, dark]
		);
		const result = plugin.highlight({ code: 'a', language: 'ts', themes: [dark, dark] });
		expect(result?.tokens[0][0].color).toBe('dark:ts');
	});

	it('returns nothing without a highlighter', () => {
		const plugin = createCachedCodePlugin(
			() => undefined,
			() => [light, light]
		);
		expect(plugin.highlight(options('a'))).toBeNull();
	});
});

describe('createTokenCache', () => {
	const result = (text: string) => ({ tokens: [[{ content: text }]] });

	it('drops the least recently used block past the entry limit', () => {
		const cache = createTokenCache({ maxEntries: 2 });
		cache.set('p:', 'a', result('a'));
		cache.set('p:', 'b', result('b'));
		cache.get('p:a');
		cache.set('p:', 'c', result('c'));
		expect(cache.get('p:a')).toBeDefined();
		expect(cache.get('p:b')).toBeUndefined();
		expect(cache.get('p:c')).toBeDefined();
	});

	it('drops old blocks past the character budget', () => {
		const cache = createTokenCache({ maxChars: 5 });
		cache.set('p:', 'aaa', result('a'));
		cache.set('p:', 'bbb', result('b'));
		expect(cache.get('p:aaa')).toBeUndefined();
		expect(cache.get('p:bbb')).toBeDefined();
	});

	it('replaces the previous version of a block that grows while streaming', () => {
		const cache = createTokenCache();
		cache.set('p:', 'other', result('other'));
		cache.set('p:', 'con', result('con'));
		cache.set('p:', 'const', result('const'));
		cache.set('p:', 'const a', result('const a'));
		expect(cache.size).toBe(2);
		expect(cache.get('p:other')).toBeDefined();
		expect(cache.get('p:const a')).toBeDefined();
	});

	it('keeps a shorter block of another language or theme', () => {
		const cache = createTokenCache();
		cache.set('light:', 'con', result('con'));
		cache.set('dark:', 'const', result('const'));
		expect(cache.size).toBe(2);
	});
});
