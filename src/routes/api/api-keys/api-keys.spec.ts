import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { GET, POST } = await import('./+server.js');
const { DELETE: DELETE_KEY, PATCH } = await import('./[id]/+server.js');

type Db = ReturnType<typeof getDb>;

interface CallInit {
	user?: { id: string; role?: string } | null;
	params?: Record<string, string>;
	body?: unknown;
	method?: string;
}

async function call<T = unknown>(
	handler: (event: never) => Response | Promise<Response>,
	init: CallInit = {}
): Promise<{ status: number; body: T }> {
	const url = new URL('http://localhost/api/api-keys');
	let body: string | undefined;
	if (init.body !== undefined) body = JSON.stringify(init.body);
	const event = {
		locals: { user: init.user ?? null, session: null } as unknown as App.Locals,
		params: init.params ?? {},
		request: new Request(url, {
			method: init.method ?? (body !== undefined ? 'POST' : 'GET'),
			body
		}),
		url
	};
	try {
		const res = await handler(event as never);
		return { status: res.status, body: (await res.json()) as T };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: e.body as T };
		throw e;
	}
}

const u1 = { id: 'u1', role: 'user' };
const u2 = { id: 'u2', role: 'user' };

function seedUsers(db: Db) {
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
		 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'),
		 ('u2', 'd@e.f', 'D', 0, 0, 0, 'user')`
	).run();
}

beforeEach(() => {
	closeDb();
	seedUsers(getDb());
});

describe('api-keys endpoints', () => {
	it('POST creates a key and returns the raw key once', async () => {
		const res = await call<{ key: Record<string, unknown> }>(POST, {
			user: u1,
			body: { label: 'ci' }
		});
		expect(res.status).toBe(201);
		expect(res.body.key.rawKey).toMatch(/^aic_/);
		expect(res.body.key.label).toBe('ci');
		expect(res.body.key.scopes).toEqual(['agents:run']);
		expect(res.body.key).not.toHaveProperty('hash');
	});

	it('GET lists keys without hash or raw key', async () => {
		await call(POST, { user: u1, body: { label: 'ci' } });
		const res = await call<{ keys: Record<string, unknown>[] }>(GET, { user: u1 });
		expect(res.status).toBe(200);
		expect(res.body.keys).toHaveLength(1);
		expect(res.body.keys[0]).not.toHaveProperty('hash');
		expect(res.body.keys[0]).not.toHaveProperty('rawKey');
		expect(res.body.keys[0].label).toBe('ci');
	});

	it('DELETE is scoped to the owner', async () => {
		const created = await call<{ key: { id: string } }>(POST, {
			user: u1,
			body: { label: 'ci' }
		});
		const id = created.body.key.id;
		expect((await call(DELETE_KEY, { user: u2, params: { id }, method: 'DELETE' })).status).toBe(
			404
		);
		const res = await call<{ ok: boolean }>(DELETE_KEY, {
			user: u1,
			params: { id },
			method: 'DELETE'
		});
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
		expect((await call(GET, { user: u1 })).status).toBe(200);
	});

	it('PATCH changes scopes and MCP access, scoped to the owner', async () => {
		const created = await call<{ key: { id: string } }>(POST, {
			user: u1,
			body: { label: 'claude', scopes: ['llm:invoke'] }
		});
		const id = created.body.key.id;
		const body = {
			label: 'claude code',
			scopes: ['mcp:use'],
			mcpAccess: [{ serverId: 's1', tools: ['search_memory'] }]
		};
		expect((await call(PATCH, { user: u2, params: { id }, method: 'PATCH', body })).status).toBe(
			404
		);
		const res = await call<{ key: Record<string, unknown> }>(PATCH, {
			user: u1,
			params: { id },
			method: 'PATCH',
			body
		});
		expect(res.status).toBe(200);
		expect(res.body.key).toMatchObject(body);

		const reset = await call<{ key: Record<string, unknown> }>(PATCH, {
			user: u1,
			params: { id },
			method: 'PATCH',
			body: { mcpAccess: null }
		});
		expect(reset.body.key).toMatchObject({ label: 'claude code', mcpAccess: null });
	});

	it('rejects unknown scopes', async () => {
		const res = await call(POST, { user: u1, body: { label: 'x', scopes: ['root'] } });
		expect(res.status).toBe(400);
	});
});
