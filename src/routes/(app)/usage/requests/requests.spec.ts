import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createProxyRequest, finalizeProxyRequest } =
	await import('$lib/server/db/repo/proxy-requests.js');
const { load: loadList } = await import('./+page.server.js');
const { load: loadDetail } = await import('./[id]/+page.server.js');
const { load: loadOverview } = await import('../+page.server.js');

type User = { id: string; role: string };
const admin: User = { id: 'admin', role: 'admin' };
const alice: User = { id: 'alice', role: 'user' };

let aliceRequest: string;
let bobRequest: string;

function seed() {
	const db = getDb();
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
		 ('admin', 'admin@x.y', 'Admin', 0, 0, 0, 'admin'),
		 ('alice', 'alice@x.y', 'Alice', 0, 0, 0, 'user'),
		 ('bob', 'bob@x.y', 'Bob', 0, 0, 0, 'user')`
	).run();
	db.prepare(
		`INSERT INTO providers (id, name, type, enabled, created_at)
		 VALUES ('p1', 'OpenRouter', 'openai-compatible', 1, 0),
		        ('p2', 'Anthropic', 'anthropic', 1, 0)`
	).run();
	const log = (userId: string, model: string, providerId: string) => {
		const row = createProxyRequest(db, {
			userId,
			endpoint: 'chat.completions',
			requestedModel: model,
			stream: false
		});
		finalizeProxyRequest(db, row.id, { status: 'complete', providerId, costUsd: 0.01 });
		return row.id;
	};
	log('admin', 'admin-model', 'p1');
	aliceRequest = log('alice', 'alice-model', 'p1');
	log('alice', 'alice-model', 'p2');
	bobRequest = log('bob', 'bob-model', 'p2');
}

function listEvent(user: User, query = '') {
	return {
		locals: { user, session: null } as unknown as App.Locals,
		url: new URL(`http://localhost/usage/requests${query}`)
	} as never;
}

function detailEvent(user: User, id: string) {
	return {
		locals: { user, session: null } as unknown as App.Locals,
		params: { id }
	} as never;
}

interface ListData {
	isAdmin: boolean;
	range: string;
	totalResults: number;
	stats: { total: number; costUsd: number };
	requests: { userId: string; providerId: string | null }[];
	filters: Record<string, string>;
	filterOptions: {
		users: { id: string; name: string }[];
		models: string[];
		providers: { id: string; name: string }[];
	};
}

async function list(user: User, query = ''): Promise<ListData> {
	return (await loadList(listEvent(user, query))) as unknown as ListData;
}

async function detailStatus(user: User, id: string): Promise<number> {
	try {
		await loadDetail(detailEvent(user, id));
		return 200;
	} catch (e) {
		if (isHttpError(e)) return e.status;
		throw e;
	}
}

beforeEach(() => {
	closeDb();
	seed();
});

describe('usage requests page load', () => {
	it('shows admins every user and lets them filter by user', async () => {
		const all = await list(admin);
		expect(all.isAdmin).toBe(true);
		expect(all.totalResults).toBe(4);
		expect(all.filterOptions.users.map((u) => u.id).sort()).toEqual(['admin', 'alice', 'bob']);

		const bobOnly = await list(admin, '?user=bob');
		expect(bobOnly.requests.map((r) => r.userId)).toEqual(['bob']);
	});

	it('scopes non-admins to their own requests, ignoring a user filter', async () => {
		const own = await list(alice, '?user=bob');
		expect(own.isAdmin).toBe(false);
		expect(own.filters.user).toBe('');
		expect(own.totalResults).toBe(2);
		expect(own.requests.every((r) => r.userId === 'alice')).toBe(true);
		expect(own.stats.total).toBe(2);
		// Filter options never leak other users' values.
		expect(own.filterOptions.users).toEqual([]);
		expect(own.filterOptions.models).toEqual(['alice-model']);
	});

	it('filters by served provider', async () => {
		const res = await list(alice, '?provider=p2');
		expect(res.totalResults).toBe(1);
		expect(res.requests[0].providerId).toBe('p2');
		expect(res.filters.provider).toBe('p2');
		expect(res.filterOptions.providers).toEqual([
			{ id: 'p2', name: 'Anthropic' },
			{ id: 'p1', name: 'OpenRouter' }
		]);
	});

	it('defaults the range to the shared period unless one is given', async () => {
		expect((await list(alice)).range).toBe('30d');
		expect((await list(alice, '?period=90d')).range).toBe('90d');
		const explicit = await list(alice, '?period=90d&range=24h');
		expect(explicit.range).toBe('24h');
		expect(explicit.filters).toMatchObject({ range: '24h', period: '90d' });
	});

	it('404s request details owned by someone else for non-admins', async () => {
		expect(await detailStatus(alice, aliceRequest)).toBe(200);
		expect(await detailStatus(alice, bobRequest)).toBe(404);
		expect(await detailStatus(admin, bobRequest)).toBe(200);
	});

	it("matches the Overview's totals for the same scope and period", async () => {
		for (const viewer of [admin, alice]) {
			const overview = (await loadOverview({
				locals: { user: viewer, session: null } as unknown as App.Locals,
				url: new URL('http://localhost/usage?period=7d')
			} as never)) as unknown as {
				requestsUser: string;
				payg: { totalRequests: number; totalCostUsd: number };
			};
			// The Overview links admins to their own requests ("Me"), never everyone's.
			expect(overview.requestsUser).toBe(viewer === admin ? 'admin' : '');
			const query = `?period=7d${overview.requestsUser ? `&user=${overview.requestsUser}` : ''}`;
			const requests = await list(viewer, query);
			expect(requests.stats.total).toBe(overview.payg.totalRequests);
			expect(requests.stats.costUsd).toBeCloseTo(overview.payg.totalCostUsd);
		}
	});
});
