import { describe, expect, it } from 'vitest';
import { manifestIcons, sniffImageType } from './favicon.js';

describe('sniffImageType', () => {
	it.each([
		[[0x89, 0x50, 0x4e, 0x47, 0x0d], 'image/png'],
		[[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'image/gif'],
		[[0xff, 0xd8, 0xff, 0xe0], 'image/jpeg'],
		[[0x00, 0x00, 0x01, 0x00, 0x01], 'image/x-icon']
	])('detects %j as %s', (bytes, type) => {
		expect(sniffImageType(Buffer.from(bytes))).toBe(type);
	});

	it('detects SVG by its root element, after an XML prolog', () => {
		expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
			'image/svg+xml'
		);
		expect(sniffImageType(Buffer.from('<?xml version="1.0"?>\n<!-- x -->\n<svg>'))).toBe(
			'image/svg+xml'
		);
	});

	it('rejects HTML and other text', () => {
		expect(sniffImageType(Buffer.from('<!doctype html><html><svg></svg>'))).toBeNull();
		expect(sniffImageType(Buffer.from('Not found'))).toBeNull();
		expect(sniffImageType(Buffer.alloc(0))).toBeNull();
	});
});

describe('manifestIcons', () => {
	it('ranks any-purpose icons by fit, then maskable ones, and skips monochrome', () => {
		const json = JSON.stringify({
			icons: [
				{ src: '/m.png', sizes: '192x192', purpose: 'maskable' },
				{ src: '/mono.svg', purpose: 'monochrome' },
				{ src: '/512.png', sizes: '512x512' },
				{ src: 'icons/192.png', sizes: '192x192', purpose: 'any maskable' },
				{ src: 'javascript:alert(1)' },
				{ src: 42 }
			]
		});
		expect(manifestIcons(json, 'https://a.example/app/site.webmanifest')).toEqual([
			'https://a.example/app/icons/192.png',
			'https://a.example/512.png',
			'https://a.example/m.png'
		]);
	});

	it('returns nothing for invalid manifests', () => {
		expect(manifestIcons('not json', 'https://a.example/m.json')).toEqual([]);
		expect(manifestIcons('null', 'https://a.example/m.json')).toEqual([]);
		expect(manifestIcons('{"icons":{}}', 'https://a.example/m.json')).toEqual([]);
	});
});
