import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

// The server's self-reported id per base URL; unknown URLs are unreachable.
const remoteIds = new Map<string, string>();
vi.mock('$lib/server/t3/client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/t3/client.js')>();
	return {
		...actual,
		fetchEnvironmentDescriptor: vi.fn(async (baseUrl: string) => {
			const environmentId = remoteIds.get(baseUrl);
			if (!environmentId) throw new actual.T3ClientError('unreachable', 'unreachable');
			return { environmentId, label: null, serverVersion: null, orchestrationProtocolVersion: 1 };
		})
	};
});

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createCodingEnvironment, listCodingEnvironments, MAX_CODING_ENVIRONMENTS_PER_USER } =
	await import('$lib/server/db/repo/coding-environments.js');
const { POST } = await import('./+server.js');
const { PATCH } = await import('./[id]/+server.js');

async function patch(
	id: string,
	body: unknown
): Promise<{ status: number; body: { message?: string } }> {
	const url = new URL(`http://localhost/api/coding-environments/${id}`);
	const event = {
		locals: { user: { id: 'u1', role: 'user' }, session: null } as unknown as App.Locals,
		params: { id },
		request: new Request(url, { method: 'PATCH', body: JSON.stringify(body) }),
		url
	};
	try {
		const res = await PATCH(event as never);
		return { status: res.status, body: await res.json() };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: e.body as { message?: string } };
		throw e;
	}
}

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
			baseUrl: `http://t3-${i}.test`,
			token: 't'
		});
	}
}

beforeEach(() => {
	remoteIds.clear();
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
		remoteIds.set('http://t3.test', 'env-1');
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

	it('rejects a server that is already connected under the same URL', async () => {
		createCodingEnvironment(getDb(), 'u1', {
			name: 'Devbox',
			baseUrl: 'http://t3.test',
			token: 't'
		});
		const res = await post({ ...body, baseUrl: 'http://T3.test/' });
		expect(res.status).toBe(409);
		expect(res.body.message).toMatch(/already connected as "Devbox"/);
		expect(listCodingEnvironments(getDb(), 'u1')).toHaveLength(1);
	});

	it('rejects the same server under a different URL by its environment id', async () => {
		remoteIds.set('http://devbox.tailnet.test', 'env-1');
		remoteIds.set('http://100.64.0.1:3773', 'env-1');
		expect((await post({ ...body, baseUrl: 'http://devbox.tailnet.test' })).status).toBe(201);
		const res = await post({ ...body, baseUrl: 'http://100.64.0.1:3773' });
		expect(res.status).toBe(409);
		expect(listCodingEnvironments(getDb(), 'u1')).toHaveLength(1);
	});

	it('rejects a server it cannot reach, since it cannot tell whether it is a duplicate', async () => {
		remoteIds.set('http://devbox.tailnet.test', 'env-1');
		expect((await post({ ...body, baseUrl: 'http://devbox.tailnet.test' })).status).toBe(201);
		// Offline second URL of the same server: its id is unknown, so it isn't saved.
		const res = await post({ ...body, baseUrl: 'http://100.64.0.1:3773' });
		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/Couldn't reach this T3 Code server/);
		expect(listCodingEnvironments(getDb(), 'u1')).toHaveLength(1);
	});

	it('allows different servers', async () => {
		remoteIds.set('http://a.test', 'env-a');
		remoteIds.set('http://b.test', 'env-b');
		expect((await post({ ...body, baseUrl: 'http://a.test' })).status).toBe(201);
		expect((await post({ ...body, baseUrl: 'http://b.test' })).status).toBe(201);
		expect(listCodingEnvironments(getDb(), 'u1')).toHaveLength(2);
	});
});

describe('PATCH /api/coding-environments/[id]', () => {
	it('rejects moving an environment to the URL of another one', async () => {
		createCodingEnvironment(getDb(), 'u1', { name: 'A', baseUrl: 'http://a.test', token: 't' });
		const b = createCodingEnvironment(getDb(), 'u1', {
			name: 'B',
			baseUrl: 'http://b.test',
			token: 't'
		});
		const res = await patch(b.id, { baseUrl: 'http://a.test', token: 'new' });
		expect(res.status).toBe(409);
		expect(listCodingEnvironments(getDb(), 'u1').find((e) => e.id === b.id)?.base_url).toBe(
			'http://b.test'
		);
	});

	it('rejects moving an environment to a URL it cannot reach', async () => {
		const a = createCodingEnvironment(getDb(), 'u1', {
			name: 'A',
			baseUrl: 'http://a.test',
			token: 't'
		});
		const res = await patch(a.id, { baseUrl: 'http://offline.test', token: 'new' });
		expect(res.status).toBe(400);
		expect(listCodingEnvironments(getDb(), 'u1')[0]?.base_url).toBe('http://a.test');
	});

	it('still allows editing an environment without moving it', async () => {
		const a = createCodingEnvironment(getDb(), 'u1', {
			name: 'A',
			baseUrl: 'http://a.test',
			token: 't',
			enabled: false
		});
		const res = await patch(a.id, { name: 'Renamed', baseUrl: 'http://a.test' });
		expect(res.status).toBe(200);
	});
});
