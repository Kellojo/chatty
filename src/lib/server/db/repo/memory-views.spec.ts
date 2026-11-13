import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { openDatabase } = await import('../index.js');
const repo = await import('./memory-views.js');

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 13, 12);

describe('memory views repo', () => {
	let db: ReturnType<typeof openDatabase>;

	beforeEach(() => {
		db = openDatabase(':memory:');
		const insertUser = db.prepare(
			'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, 0, 0, \'user\')'
		);
		insertUser.run('u1', 'One', 'one@example.com');
		insertUser.run('u2', 'Two', 'two@example.com');
	});

	const view = (
		kind: 'search' | 'read',
		scope: 'user' | 'shared',
		path: string,
		userId: string,
		agent: boolean,
		at: number
	) => repo.recordMemoryViews(db, { kind, concepts: [{ scope, path }], userId, agent, at });

	it('totals search hits and reads, with the agent share and the last view', () => {
		view('search', 'user', 'a.md', 'u1', false, NOW - DAY);
		view('search', 'user', 'a.md', 'u1', true, NOW);
		view('read', 'user', 'a.md', 'u1', true, NOW - 2 * DAY);
		// Another user's private concept at the same path is not counted.
		view('read', 'user', 'a.md', 'u2', false, NOW + 1);

		expect(repo.getMemoryViewTotals(db, 'user', 'a.md', 'u1')).toEqual({
			searchHits: 2,
			reads: 1,
			agentSearchHits: 1,
			agentReads: 1,
			lastViewedAt: NOW
		});
		expect(repo.getMemoryViewTotals(db, 'user', 'missing.md', 'u1')).toEqual({
			searchHits: 0,
			reads: 0,
			agentSearchHits: 0,
			agentReads: 0,
			lastViewedAt: null
		});
	});

	it('counts every user’s views of a shared concept', () => {
		view('read', 'shared', 's.md', 'u1', false, NOW);
		view('read', 'shared', 's.md', 'u2', false, NOW);
		expect(repo.getMemoryViewTotals(db, 'shared', 's.md', 'u1').reads).toBe(2);
	});

	it('carries views to a renamed concept, merging rows already there', () => {
		view('read', 'user', 'old.md', 'u1', false, NOW);
		view('search', 'user', 'old.md', 'u1', false, NOW - DAY);
		view('read', 'user', 'new.md', 'u1', false, NOW);
		view('read', 'user', 'old.md', 'u2', false, NOW);

		repo.moveMemoryViews(db, 'user', 'u1', 'old.md', 'new.md');

		expect(repo.getMemoryViewTotals(db, 'user', 'new.md', 'u1')).toMatchObject({
			reads: 2,
			searchHits: 1
		});
		expect(repo.getMemoryViewTotals(db, 'user', 'old.md', 'u1').reads).toBe(0);
		// Another user's own concept that happens to share the old path stays put.
		expect(repo.getMemoryViewTotals(db, 'user', 'old.md', 'u2').reads).toBe(1);
	});
});
