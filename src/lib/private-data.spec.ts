import { describe, expect, it } from 'vitest';
import { PRIVACY_NOTICE_PART, readPrivacyNotice } from './private-data.js';
import { hasVisibleContent } from './components/app/timeline.js';

describe('privacy notice part', () => {
	it('reads the reason, with a fallback for bad data', () => {
		expect(
			readPrivacyNotice({ type: PRIVACY_NOTICE_PART, data: { reason: 'a private note' } } as never)
		).toEqual({
			reason: 'a private note'
		});
		expect(readPrivacyNotice({ type: PRIVACY_NOTICE_PART, data: {} } as never)).toEqual({
			reason: 'private data'
		});
		expect(readPrivacyNotice({ type: 'text' })).toBeNull();
	});

	it('counts as visible content in a reply', () => {
		expect(hasVisibleContent([{ type: 'step-start' }, { type: PRIVACY_NOTICE_PART }])).toBe(true);
	});
});
