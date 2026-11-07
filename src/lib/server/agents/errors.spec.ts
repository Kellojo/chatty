import { describe, expect, it } from 'vitest';
import { describeError } from './errors.js';

describe('describeError', () => {
	it('uses the message of errors and error-like objects', () => {
		expect(describeError(new Error('boom'))).toBe('boom');
		expect(describeError({ message: 'rate limited', status: 429 })).toBe('rate limited');
	});

	it('serialises other objects instead of printing [object Object]', () => {
		expect(describeError({ code: 'E1' })).toBe('{"code":"E1"}');
		expect(describeError('plain')).toBe('plain');
		expect(describeError(undefined)).toBe('Unknown error');
	});

	it('falls back for circular objects', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(describeError(circular)).toBe('Unknown error');
	});
});
