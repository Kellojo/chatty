import { describe, expect, it } from 'vitest';
import { codingAssetUrl, escapeLocalImagePaths, isLocalImagePath } from './coding-assets.js';

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

describe('escapeLocalImagePaths', () => {
	it('doubles backslashes in local image destinations', () => {
		expect(escapeLocalImagePaths(String.raw`See ![shot](C:\me\.t3\a.png) here`)).toBe(
			String.raw`See ![shot](C:\\me\\.t3\\a.png) here`
		);
		expect(escapeLocalImagePaths(String.raw`![s](<C:\My Shots\.x\a.png>)`)).toBe(
			String.raw`![s](<C:\\My Shots\\.x\\a.png>)`
		);
		expect(escapeLocalImagePaths(String.raw`![s](\\nas\shots\a.png)`)).toBe(
			String.raw`![s](\\\\nas\\shots\\a.png)`
		);
	});

	it('leaves code, URLs, links and already-escaped paths alone', () => {
		const untouched = [
			'```\n' + String.raw`![s](C:\me\.t3\a.png)` + '\n```',
			'`' + String.raw`![s](C:\me\.t3\a.png)` + '`',
			String.raw`[link](C:\me\.t3\a.png)`,
			String.raw`![s](C:\\me\\.t3\\a.png)`,
			'![s](https://example.com/a.png)',
			String.raw`![s](C:\me\notes.txt)`
		];
		for (const md of untouched) expect(escapeLocalImagePaths(md)).toBe(md);
	});
});
