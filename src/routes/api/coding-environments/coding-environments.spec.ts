import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createCodingEnvironment, listCodingEnvironments, MAX_CODING_ENVIRONMENTS_PER_USER } =
	await import('$lib/server/db/repo/coding-environments.js');
const { POST } = await import('./+server.js');

async function post(body: unknown): Promise<{ status: number; body: { message?: string } }> {
	const url = new URL('http://localhost/api/coding-environments');
	const event = {
		locals: { user: { id: 'u1', role: 'user' }, session: null } as unknown as App.Locals,
		params: {},
		request: new Request(url, { method: 'POST', body: JSON.stringify(body) }),
		url
	};
	try {
		const res = await POST(event as never);
		return { status: res.status, body: await res.json() };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: e.body as { message?: string } };
		throw e;
	}
}

const body = { name: 'T3', baseUrl: 'http://t3.test', token: 'token', enabled: false };

function seed(count: number) {
	for (let i = 0; i < count; i++) {
		createCodingEnvironment(getDb(), 'u1', {
			name: `T3 ${i}`,
			baseUrl: 'http://t3.test',
			token: 't'
		});
	}
}

beforeEach(() => {
	closeDb();
	getDb()
		.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
			 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user')`
		)
		.run();
});

describe('POST /api/coding-environments', () => {
	it('creates an environment below the per-user limit', async () => {
		seed(MAX_CODING_ENVIRONMENTS_PER_USER - 1);
		const res = await post(body);
		expect(res.status).toBe(201);
		expect(listCodingEnvironments(getDb(), 'u1')).toHaveLength(MAX_CODING_ENVIRONMENTS_PER_USER);
	});

	it('rejects an environment beyond the per-user limit', async () => {
		seed(MAX_CODING_ENVIRONMENTS_PER_USER);
		const res = await post(body);
		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/at most 20 coding environments/);
		expect(listCodingEnvironments(getDb(), 'u1')).toHaveLength(MAX_CODING_ENVIRONMENTS_PER_USER);
	});
});
