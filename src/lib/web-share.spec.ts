import { describe, expect, it } from 'vitest';
import { MAX_SHARE_TEXT, buildSharePayload, canShare, shareFileName } from './web-share';

describe('buildSharePayload', () => {
	it('shares short text as text, with the title when given', () => {
		expect(buildSharePayload({ title: 'Chat', text: 'hi' }, () => true)).toEqual({
			title: 'Chat',
			text: 'hi'
		});
		expect(buildSharePayload({ text: 'hi' }, () => true)).toEqual({ text: 'hi' });
	});

	it('shares long text as a markdown file when files are allowed', async () => {
		const text = 'a'.repeat(MAX_SHARE_TEXT + 1);
		const payload = buildSharePayload({ title: 'Notes', text }, () => true);
		expect(payload.text).toBeUndefined();
		expect(payload.title).toBe('Notes');
		const [file] = payload.files ?? [];
		expect(file.name).toBe('Notes.md');
		expect(file.type).toBe('text/markdown');
		expect(await file.text()).toBe(text);
	});

	it('falls back to text when files are not allowed', () => {
		const text = 'a'.repeat(MAX_SHARE_TEXT + 1);
		expect(buildSharePayload({ text }, () => false)).toEqual({ text });
	});

	it('keeps text at exactly the limit as text', () => {
		const text = 'a'.repeat(MAX_SHARE_TEXT);
		expect(buildSharePayload({ text }, () => true)).toEqual({ text });
	});
});

describe('shareFileName', () => {
	it('strips unsafe characters and falls back to a generic name', () => {
		expect(shareFileName('a/b: "c"?')).toBe('a b c.md');
		expect(shareFileName('  ')).toBe('shared.md');
		expect(shareFileName()).toBe('shared.md');
	});
});

describe('canShare', () => {
	it('is false without navigator.share (node)', () => {
		expect(canShare()).toBe(false);
	});
});
