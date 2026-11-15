import { APICallError, RetryError } from 'ai';
import { describe, expect, it } from 'vitest';
import { isRetryableModelError, ModelUnavailableError } from './mapped.js';

function apiError(opts: { statusCode?: number; isRetryable?: boolean }): APICallError {
	return new APICallError({
		message: 'Cannot connect to API',
		url: 'http://127.0.0.1:47831/v1/chat/completions',
		requestBodyValues: {},
		...opts
	});
}

describe('isRetryableModelError', () => {
	it('retries a refused connection, which has no status code', () => {
		expect(isRetryableModelError(apiError({ isRetryable: true }))).toBe(true);
	});

	it('unwraps the SDK retry wrapper', () => {
		const wrapped = new RetryError({
			message: 'Failed after 3 attempts',
			reason: 'maxRetriesExceeded',
			errors: [apiError({ isRetryable: true }), apiError({ isRetryable: true })]
		});
		expect(isRetryableModelError(wrapped)).toBe(true);
	});

	it('retries server errors and unavailable models', () => {
		expect(isRetryableModelError(apiError({ statusCode: 503 }))).toBe(true);
		expect(isRetryableModelError(new ModelUnavailableError('gone'))).toBe(true);
	});

	it('does not retry client errors', () => {
		expect(isRetryableModelError(apiError({ statusCode: 400 }))).toBe(false);
		expect(isRetryableModelError(new Error('plain'))).toBe(false);
	});
});
