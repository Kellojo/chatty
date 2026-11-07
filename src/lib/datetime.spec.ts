import { describe, expect, it } from 'vitest';
import { formatTimeAgo } from './datetime.js';

describe('formatTimeAgo', () => {
	it('returns "just now" for under a minute', () => {
		const now = Date.now();
		expect(formatTimeAgo(now, now)).toBe('just now');
		expect(formatTimeAgo(now - 59_000, now)).toBe('just now');
	});

	it('returns minutes ago', () => {
		const now = Date.now();
		expect(formatTimeAgo(now - 5 * 60_000, now)).toBe('5m ago');
		expect(formatTimeAgo(now - 59 * 60_000, now)).toBe('59m ago');
	});

	it('returns hours ago', () => {
		const now = Date.now();
		expect(formatTimeAgo(now - 2 * 3_600_000, now)).toBe('2h ago');
		expect(formatTimeAgo(now - 23 * 3_600_000, now)).toBe('23h ago');
	});

	it('returns days ago', () => {
		const now = Date.now();
		expect(formatTimeAgo(now - 3 * 86_400_000, now)).toBe('3d ago');
		expect(formatTimeAgo(now - 29 * 86_400_000, now)).toBe('29d ago');
	});

	it('falls back to an absolute date beyond 30 days', () => {
		const now = Date.now();
		const result = formatTimeAgo(now - 31 * 86_400_000, now);
		expect(result).not.toContain('ago');
		expect(result).toMatch(/\d{4}/);
	});
});
