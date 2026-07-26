import { describe, expect, it } from 'vitest';
import { formatCount } from './formats.js';

describe('formatCount', () => {
	it('formats small numbers plainly', () => {
		expect(formatCount(0)).toBe('0');
		expect(formatCount(843)).toBe('843');
		expect(formatCount(999)).toBe('999');
	});

	it('formats thousands with k suffix', () => {
		expect(formatCount(1000)).toBe('1k');
		expect(formatCount(1500)).toBe('1.5k');
		expect(formatCount(999_999)).toBe('1000k');
	});

	it('formats millions with M suffix', () => {
		expect(formatCount(1_000_000)).toBe('1M');
		expect(formatCount(2_500_000)).toBe('2.5M');
	});
});
