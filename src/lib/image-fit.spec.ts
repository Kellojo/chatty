import { describe, expect, it } from 'vitest';
import { fitRotated, isSideways, normalizeRotation } from './image-fit.js';

describe('normalizeRotation', () => {
	it('folds any multiple of 90 into [0, 360)', () => {
		expect(normalizeRotation(-90)).toBe(270);
		expect(normalizeRotation(450)).toBe(90);
		expect(normalizeRotation(-720)).toBe(0);
		expect(isSideways(-270)).toBe(true);
		expect(isSideways(180)).toBe(false);
	});
});

describe('fitRotated', () => {
	it('fits an upright image without upscaling', () => {
		expect(fitRotated(200, 100, 448, 384, 0)).toEqual({
			width: 200,
			height: 100,
			boxWidth: 200,
			boxHeight: 100
		});
	});

	it('swaps the box for a sideways image and fits the rotated footprint', () => {
		// Landscape 800x400 turned sideways is visually 400x800: height-bound to 384.
		const fit = fitRotated(800, 400, 448, 384, 90);
		expect(fit.boxHeight).toBe(384);
		expect(fit.boxWidth).toBe(192);
		expect(fit.width).toBe(384);
		expect(fit.height).toBe(192);
	});

	it('upscales on request and survives an empty bound', () => {
		expect(fitRotated(100, 50, 400, 400, 0, { upscale: true }).width).toBe(400);
		expect(fitRotated(100, 50, 0, 400, 0).width).toBe(0);
	});
});
