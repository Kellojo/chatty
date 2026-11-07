import { describe, expect, it } from 'vitest';
import { formatCost, formatCount, formatSpend } from './formats.js';

describe('formatCount', () => {
	it('formats small numbers plainly', () => {
		expect(formatCount(0)).toBe('0');
		expect(formatCount(843)).toBe('843');
		expect(formatCount(999)).toBe('999');
	});

	it('formats thousands with k suffix', () => {
		expect(formatCount(1000)).toBe('1k');
		expect(formatCount(1500)).toBe('1.5k');
		expect(formatCount(999_949)).toBe('999.9k');
	});

	it('rolls over to the next unit instead of showing 1000k', () => {
		expect(formatCount(999_999)).toBe('1M');
		expect(formatCount(999_999_999)).toBe('1B');
	});

	it('formats millions, billions and trillions', () => {
		expect(formatCount(1_000_000)).toBe('1M');
		expect(formatCount(2_500_000)).toBe('2.5M');
		expect(formatCount(3_140_000_000)).toBe('3.1B');
		expect(formatCount(1_200_000_000_000)).toBe('1.2T');
		expect(formatCount(4_500_000_000_000_000)).toBe('4500T');
	});

	it('handles negatives and non-finite values', () => {
		expect(formatCount(-1500)).toBe('-1.5k');
		expect(formatCount(Number.NaN)).toBe('—');
	});
});

describe('formatCost', () => {
	it('keeps sub-cent precision for single calls and shows zero plainly', () => {
		expect(formatCost(null)).toBe('—');
		expect(formatCost(0)).toBe('$0');
		expect(formatCost(0.00042)).toBe('$0.00042');
		expect(formatCost(1.234)).toBe('$1.23');
	});
});

describe('formatSpend', () => {
	it('rounds totals to cents with a floor marker below one cent', () => {
		expect(formatSpend(null)).toBe('—');
		expect(formatSpend(0)).toBe('$0');
		expect(formatSpend(0.00042)).toBe('<$0.01');
		expect(formatSpend(0.01)).toBe('$0.01');
		expect(formatSpend(12.345)).toBe('$12.35');
		expect(formatSpend(1234.5)).toBe('$1,234.50');
		expect(formatSpend(-2)).toBe('-$2.00');
	});
});
