import { describe, expect, it } from 'vitest';
import { deriveBodySizeLimit } from './body-size-limit.js';

describe('deriveBodySizeLimit', () => {
	it('derives the limit from MAX_ATTACHMENT_SIZE_MB', () => {
		expect(deriveBodySizeLimit({ MAX_ATTACHMENT_SIZE_MB: '50' })).toBe('50M');
		expect(deriveBodySizeLimit({ MAX_ATTACHMENT_SIZE_MB: '10' })).toBe('10M');
	});

	it('keeps an explicitly set BODY_SIZE_LIMIT', () => {
		expect(deriveBodySizeLimit({ BODY_SIZE_LIMIT: '500M', MAX_ATTACHMENT_SIZE_MB: '50' })).toBe(
			'500M'
		);
	});

	it('falls back to 50M when MAX_ATTACHMENT_SIZE_MB is missing or invalid', () => {
		expect(deriveBodySizeLimit({})).toBe('50M');
		expect(deriveBodySizeLimit({ MAX_ATTACHMENT_SIZE_MB: 'abc' })).toBe('50M');
		expect(deriveBodySizeLimit({ MAX_ATTACHMENT_SIZE_MB: '-5' })).toBe('50M');
	});
});
