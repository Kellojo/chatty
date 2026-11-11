import { describe, expect, it } from 'vitest';
import { sharedDraft } from './share-target.js';

const draft = (query: string) => sharedDraft(new URLSearchParams(query));

describe('sharedDraft', () => {
	it('is null when the URL is not a share', () => {
		expect(draft('mode=chat')).toBeNull();
	});

	it('joins title, text and url', () => {
		expect(draft('share_title=Hi&share_text=Look&share_url=https://a.b/c')).toBe(
			'Hi\n\nLook\n\nhttps://a.b/c'
		);
	});

	it('skips a link already in the text', () => {
		expect(draft('share_text=See https://a.b/c&share_url=https://a.b/c')).toBe('See https://a.b/c');
	});

	it('skips a title repeated in the text and blank fields', () => {
		expect(draft('share_title=News&share_text=News: it happened&share_url=')).toBe(
			'News: it happened'
		);
	});

	it('gives an empty draft for an empty share', () => {
		expect(draft('share_text=')).toBe('');
	});
});
