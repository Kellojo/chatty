import { describe, expect, it } from 'vitest';
import { truncateHead, truncateTail } from './truncate.js';

describe('truncateHead', () => {
	it('leaves short text alone', () => {
		expect(truncateHead('hello', 10)).toBe('hello');
	});

	it('keeps the start of long text', () => {
		expect(truncateHead('abcdefghij', 4)).toBe('abcd\n… truncated');
	});
});

describe('truncateTail', () => {
	it('leaves short text alone', () => {
		expect(truncateTail('hello', 10)).toBe('hello');
	});

	it('keeps the end of long text with a note on how much was cut', () => {
		expect(truncateTail('abcdefghij', 4)).toBe('… 6 chars truncated\nghij');
	});

	it('starts at the next line boundary when one is close', () => {
		const text = 'x'.repeat(5000) + '\nline one\nERROR: build failed';
		const result = truncateTail(text, 25);
		expect(result).toBe(
			`… ${(5000 + 1 + 'line one'.length + 1).toLocaleString('en-US')} chars truncated\nERROR: build failed`
		);
		expect(result.endsWith('ERROR: build failed')).toBe(true);
	});
});
