import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

const { getDb } = await import('../index.js');
const { findSourceSite, rememberSourceSite, sourceHostKey } = await import('./source-sites.js');

beforeAll(() => {
	getDb()
		.prepare(
			'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, 0, 0, \'user\')'
		)
		.run('u1', 'u1', 'u1@example.com');
});

describe('source sites', () => {
	it('normalizes hosts the way the links widget shows them', () => {
		expect(sourceHostKey('WWW.Example.COM.')).toBe('example.com');
		expect(sourceHostKey('docs.example.com')).toBe('docs.example.com');
	});

	it('records a fetched page and keeps the last declared favicon', () => {
		const db = getDb();
		rememberSourceSite(
			db,
			'u1',
			'https://www.thalia.example/book/1',
			'https://www.thalia.example/fav.svg'
		);
		expect(findSourceSite(db, 'u1', 'thalia.example')).toEqual({
			host: 'thalia.example',
			origin: 'https://www.thalia.example',
			faviconUrl: 'https://www.thalia.example/fav.svg'
		});
		// A later fetch without a declared icon (or with an unusable one) keeps the known icon.
		rememberSourceSite(db, 'u1', 'https://thalia.example/other', 'javascript:alert(1)');
		expect(findSourceSite(db, 'u1', 'www.thalia.example')).toEqual({
			host: 'thalia.example',
			origin: 'https://thalia.example',
			faviconUrl: 'https://www.thalia.example/fav.svg'
		});
	});

	it('ignores non-http pages and unknown hosts', () => {
		const db = getDb();
		rememberSourceSite(db, 'u1', 'ftp://files.example/readme', null);
		rememberSourceSite(db, 'u1', 'not a url', null);
		expect(findSourceSite(db, 'u1', 'files.example')).toBeNull();
		expect(findSourceSite(db, 'u1', 'unknown.example')).toBeNull();
	});
});
