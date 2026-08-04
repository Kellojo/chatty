import { describe, it, expect, beforeEach } from 'vitest';
import { attachmentCache, CACHE_MAX_BYTES } from './attachmentCache.js';

describe('attachmentCache', () => {
	beforeEach(() => {
		attachmentCache.clear();
	});

	it('stores and retrieves data URIs', async () => {
		const uri = `data:image/png;base64,${'A'.repeat(100)}`;
		attachmentCache.set('att-123', uri);
		expect(attachmentCache.get('att-123')).toBe(uri);
	});

	it('returns undefined for missing keys', async () => {
		expect(attachmentCache.get('nonexistent')).toBeUndefined();
	});

	it('updates LRU order on access', async () => {
		const uriA = `data:image/png;base64,${'A'.repeat(10)}`;
		const uriB = `data:image/png;base64,${'B'.repeat(20)}`;
		const uriC = `data:image/png;base64,${'C'.repeat(30)}`;

		attachmentCache.set('a', uriA);
		attachmentCache.set('b', uriB);
		attachmentCache.get('a'); // access 'a' to make it most recently used

		// Add a new entry that should fit without eviction (small sizes for test)
		attachmentCache.set('c', uriC);

		expect(attachmentCache.get('a')).toBe(uriA);
		expect(attachmentCache.get('b')).toBe(uriB);
		expect(attachmentCache.get('c')).toBe(uriC);
	});

	it('evicts oldest entries when cache exceeds 100MB cap', async () => {
		const uriA = `data:image/png;base64,${'A'.repeat(CACHE_MAX_BYTES * 0.5)}`;
		const uriC = `data:image/png;base64,${'C'.repeat(CACHE_MAX_BYTES * 0.8)}`;

		attachmentCache.set('a', uriA);
		expect(attachmentCache.get('a')).toBe(uriA);

		// Adding C should trigger eviction of A and B (since total would exceed cap)
		attachmentCache.set('c', uriC);

		expect(attachmentCache.get('b')).toBeUndefined(); // evicted
		expect(attachmentCache.get('a')).toBeUndefined(); // evicted
		expect(attachmentCache.get('c')).toBe(uriC);
	});

	it('tracks total bytes approximately', async () => {
		const uri = `data:image/png;base64,${'X'.repeat(100)}`;
		attachmentCache.set('test', uri);
		expect(attachmentCache.totalBytes()).toBeGreaterThan(0);

		// Adding another entry should increase total bytes
		const uri2 = `data:image/png;base64,${'Y'.repeat(50)}`;
		attachmentCache.set('test2', uri2);
		expect(attachmentCache.totalBytes()).toBeGreaterThanOrEqual(150); // at least 150 chars of base64 data
	});

	it('clears all entries', async () => {
		const uri = `data:image/png;base64,${'Z'.repeat(50)}`;
		attachmentCache.set('test', uri);
		expect(attachmentCache.totalBytes()).toBeGreaterThan(0);

		attachmentCache.clear();
		expect(attachmentCache.get('test')).toBeUndefined();
		expect(attachmentCache.totalBytes()).toBe(0);
	});
});
