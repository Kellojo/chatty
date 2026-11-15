import { describe, expect, it } from 'vitest';
import { serverChunks, speakableText, speechChunks } from './speakable-text.js';

describe('speakableText', () => {
	it('strips markdown but keeps the words', () => {
		const md = [
			'## Summary',
			'',
			'This is **bold**, _italic_ and `code`. See [the docs](https://x.y).',
			'',
			'- first item',
			'1. numbered',
			'> quoted',
			'',
			'```ts',
			'const x = 1;',
			'```',
			'![chart](https://x.y/c.png)',
			'snake_case_name stays'
		].join('\n');
		expect(speakableText(md)).toBe(
			'Summary\n\nThis is bold, italic and code. See the docs.\n\nfirst item\nnumbered\nquoted\n\nsnake_case_name stays'
		);
	});

	it('reads table rows as comma-separated cells', () => {
		expect(speakableText('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe('a, b\n1, 2');
	});

	it('cuts long text at a sentence end within the limit', () => {
		const text = 'One sentence here. '.repeat(20);
		const out = speakableText(text, 100);
		expect(out.length).toBeLessThanOrEqual(100);
		expect(out.endsWith('.')).toBe(true);
	});
});

describe('speechChunks', () => {
	it('groups sentences up to the limit', () => {
		expect(speechChunks('Hi there. How are you? Fine!', 20)).toEqual([
			'Hi there.',
			'How are you? Fine!'
		]);
	});

	it('breaks a very long sentence at word boundaries', () => {
		const chunks = speechChunks('word '.repeat(30).trim(), 50);
		expect(chunks.every((c) => c.length <= 50)).toBe(true);
		expect(chunks.join(' ')).toBe('word '.repeat(30).trim());
	});
});

describe('serverChunks', () => {
	it('starts with a short chunk, then groups the rest into larger ones', () => {
		const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1}.`).join(' ');
		const chunks = serverChunks(text, 50, 200);
		expect(chunks[0].length).toBeLessThanOrEqual(50);
		expect(chunks.slice(1).every((c) => c.length <= 200 && c.length > 50)).toBe(true);
		expect(chunks.join(' ')).toBe(text);
	});

	it('returns nothing for empty text', () => {
		expect(serverChunks('   ')).toEqual([]);
	});
});

describe('chunk edge cases', () => {
	it('keeps paragraph breaks inside a chunk', () => {
		expect(speechChunks('First paragraph.\n\nSecond one.', 200)).toEqual([
			'First paragraph.\nSecond one.'
		]);
	});

	it('has nothing to read for punctuation only', () => {
		expect(serverChunks(speakableText('...!!!'))).toEqual([]);
	});
});
