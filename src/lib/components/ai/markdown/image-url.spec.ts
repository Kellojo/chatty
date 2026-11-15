import { describe, expect, it } from 'vitest';
import { inlineImageUrl } from './image-url.js';

describe('inlineImageUrl', () => {
	it('keeps inline data:image URIs', () => {
		expect(inlineImageUrl(' data:image/png;base64,AAAA ')).toBe('data:image/png;base64,AAAA');
		expect(inlineImageUrl('DATA:image/svg+xml,<svg/>')).toBe('DATA:image/svg+xml,<svg/>');
	});

	it('drops remote, relative and non-image URLs', () => {
		expect(inlineImageUrl('https://evil.example/p.png?d=secret')).toBeNull();
		expect(inlineImageUrl('//evil.example/p.png')).toBeNull();
		expect(inlineImageUrl('/recipes/c39/x.jpg')).toBeNull();
		expect(inlineImageUrl('data:text/html,<b>x</b>')).toBeNull();
		expect(inlineImageUrl(42)).toBeNull();
	});
});
