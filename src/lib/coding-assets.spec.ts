import { describe, expect, it } from 'vitest';
import { codingAssetUrl, isLocalImagePath } from './coding-assets.js';

describe('isLocalImagePath', () => {
	it('accepts absolute paths to raster images', () => {
		expect(isLocalImagePath('C:\\Users\\me\\shots\\a.png')).toBe(true);
		expect(isLocalImagePath('C:/Users/me/a.JPG')).toBe(true);
		expect(isLocalImagePath('/home/me/a.webp')).toBe(true);
		expect(isLocalImagePath('/Users/me/a.jpeg')).toBe(true);
		expect(isLocalImagePath('~/shots/a.gif')).toBe(true);
	});

	it('rejects URLs, app-relative paths, SVG and non-images', () => {
		expect(isLocalImagePath('https://example.com/a.png')).toBe(false);
		expect(isLocalImagePath('//cdn.example.com/a.png')).toBe(false);
		expect(isLocalImagePath('/pwa-192x192.png')).toBe(false);
		expect(isLocalImagePath('shots/a.png')).toBe(false);
		expect(isLocalImagePath('C:\\a\\b.svg')).toBe(false);
		expect(isLocalImagePath('C:\\a\\secrets.env')).toBe(false);
	});

	it('builds an encoded relay URL', () => {
		expect(codingAssetUrl('c1', 'C:\\a b\\x.png')).toBe(
			'/api/coding/tasks/c1/asset?path=C%3A%5Ca%20b%5Cx.png'
		);
	});
});
