import { describe, expect, it } from 'vitest';
import { settle } from './drawer-swipe';

describe('settle', () => {
	const width = 400;

	it('goes to the nearer side when released slowly', () => {
		expect(settle(150, 0, width).open).toBe(false);
		expect(settle(250, 0, width).open).toBe(true);
	});

	it('follows a fling, even against the distance', () => {
		expect(settle(50, 0.5, width).open).toBe(true);
		expect(settle(350, -0.5, width).open).toBe(false);
	});

	it('cancels when the finger reverses before lifting', () => {
		expect(settle(300, -0.4, width).open).toBe(false);
	});

	it('settles faster after a faster fling, within bounds', () => {
		const slow = settle(300, 0.5, width).durationMs;
		const fast = settle(300, 3, width).durationMs;
		expect(fast).toBeLessThan(slow);
		expect(fast).toBeGreaterThanOrEqual(160);
		expect(settle(0, 0, width).durationMs).toBeLessThanOrEqual(380);
	});
});
