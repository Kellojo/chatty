import { describe, expect, it } from 'vitest';
import { previewModifiers, toPagePoint } from './coding-preview.js';

describe('previewModifiers', () => {
	it('uses CDP modifier bits', () => {
		const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
		expect(previewModifiers(none)).toBe(0);
		expect(previewModifiers({ ...none, altKey: true })).toBe(1);
		expect(previewModifiers({ ...none, ctrlKey: true, shiftKey: true })).toBe(10);
		expect(previewModifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(
			15
		);
	});
});

describe('toPagePoint', () => {
	const rect = { left: 100, top: 50, width: 640, height: 400 };
	const viewport = { width: 1280, height: 800 };

	it('scales displayed coordinates to the page', () => {
		expect(toPagePoint(100, 50, rect, viewport)).toEqual({ x: 0, y: 0 });
		expect(toPagePoint(420, 250, rect, viewport)).toEqual({ x: 640, y: 400 });
		expect(toPagePoint(740, 450, rect, viewport)).toEqual({ x: 1280, y: 800 });
	});

	it('clamps points outside the frame', () => {
		expect(toPagePoint(0, 1000, rect, viewport)).toEqual({ x: 0, y: 800 });
	});

	it('handles an image that has not been laid out yet', () => {
		expect(toPagePoint(10, 10, { left: 0, top: 0, width: 0, height: 0 }, viewport)).toEqual({
			x: 0,
			y: 0
		});
	});
});
