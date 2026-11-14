import { describe, expect, it } from 'vitest';
import { addTiming, NO_TIMING, stepTiming } from './inferenceTiming.js';

describe('stepTiming', () => {
	it('splits a streamed response into first token and generation time', () => {
		expect(stepTiming({ responseTimeMs: 5000, timeToFirstOutputMs: 1200.4 })).toEqual({
			ttftMs: 1200,
			decodeMs: 3800
		});
	});
	it('reports nothing for an untimed or non-streamed step', () => {
		expect(stepTiming({ responseTimeMs: 5000 })).toEqual(NO_TIMING);
		expect(stepTiming(undefined)).toEqual(NO_TIMING);
		expect(stepTiming({ timeToFirstOutputMs: 300 })).toEqual({ ttftMs: 300, decodeMs: null });
	});
});

describe('addTiming', () => {
	it('sums timed steps and keeps untimed ones out', () => {
		const a = { ttftMs: 100, decodeMs: 1000 };
		expect(addTiming(a, { ttftMs: 50, decodeMs: 500 })).toEqual({ ttftMs: 150, decodeMs: 1500 });
		expect(addTiming(NO_TIMING, a)).toEqual(a);
		expect(addTiming(a, NO_TIMING)).toEqual(a);
	});
});
