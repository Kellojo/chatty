import { describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

const { getDb } = await import('../index.js');
const { getCachedFavicon, purgeCachedFavicons, putCachedFavicon } =
	await import('./favicon-cache.js');

describe('favicon cache', () => {
	it('stores, replaces and purges icons by age', () => {
		const db = getDb();
		putCachedFavicon(db, 'old.example', { type: 'image/png', body: Buffer.from([1]) }, 1000);
		putCachedFavicon(db, 'new.example', { type: 'image/png', body: Buffer.from([2]) }, 1000);
		putCachedFavicon(db, 'new.example', { type: 'image/x-icon', body: Buffer.from([3]) }, 5000);
		expect(getCachedFavicon(db, 'new.example')).toEqual({
			type: 'image/x-icon',
			body: Buffer.from([3]),
			fetchedAt: 5000
		});
		expect(purgeCachedFavicons(db, 2000)).toBe(1);
		expect(getCachedFavicon(db, 'old.example')).toBeNull();
		expect(getCachedFavicon(db, 'new.example')).not.toBeNull();
	});
});
