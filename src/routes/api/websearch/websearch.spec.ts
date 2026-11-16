import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { getSetting } = await import('$lib/server/db/repo/settings.js');
const { config } = await import('$lib/server/config.js');
const providerRoute = await import('./[provider]/+server.js');
const preferences = await import('./preferences/+server.js');

type Handler = (event: never) => Response | Promise<Response>;

/** The [provider] route's handlers with the path param filled in. */
function forProvider(provider: string): { PUT: Handler; DELETE: Handler } {
	const withParam =
		(handler: (event: never) => unknown): Handler =>
		(event: never) =>
			handler({ ...(event as object), params: { provider } } as never) as Promise<Response>;
	return { PUT: withParam(providerRoute.PUT), DELETE: withParam(providerRoute.DELETE) };
}

const searxng = forProvider('searxng');
const brave = forProvider('brave');
const perplexity = forProvider('perplexity');

const admin = { id: 'admin', role: 'admin' };
const user = { id: 'u1', role: 'user' };

async function call<T = Record<string, unknown>>(
	handler: (event: never) => Response | Promise<Response>,
	init: { user?: { id: string; role: string }; method: string; body?: unknown }
): Promise<{ status: number; body: T }> {
	const url = new URL('http://localhost/api/websearch');
	const event = {
		locals: { user: init.user ?? admin, session: null } as unknown as App.Locals,
		params: {},
		request: new Request(url, {
			method: init.method,
			headers: { 'content-type': 'application/json' },
			body: init.body === undefined ? undefined : JSON.stringify(init.body)
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

function stubFetch(reply: { status?: number; body: unknown; contentType?: string }) {
	const fetchMock = vi.fn<typeof fetch>(
		async () =>
			new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
				status: reply.status ?? 200,
				headers: { 'content-type': reply.contentType ?? 'application/json' }
			})
	);
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

beforeEach(() => {
	closeDb();
	getDb()
		.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
			 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'), ('admin', 'g@h.i', 'G', 0, 0, 0, 'admin')`
		)
		.run();
});

afterEach(() => {
	vi.unstubAllGlobals();
	config.SEARXNG_URL = undefined;
	config.BRAVE_SEARCH_API_KEY = undefined;
	config.PERPLEXITY_API_KEY = undefined;
});

describe('admin guard', () => {
	it('refuses non-admins', async () => {
		const fetchMock = stubFetch({ body: { results: [] } });
		for (const [handler, body] of [
			[searxng.PUT, { url: 'http://s' }],
			[brave.PUT, { apiKey: 'k' }],
			[preferences.PUT, { mode: 'fallback' }]
		] as const) {
			expect((await call(handler, { user, method: 'PUT', body })).status).toBe(403);
		}
		expect((await call(searxng.DELETE, { user, method: 'DELETE' })).status).toBe(403);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('PUT /api/websearch/searxng', () => {
	it('saves the normalized URL after a successful test query', async () => {
		const fetchMock = stubFetch({ body: { results: [] } });
		const res = await call(searxng.PUT, {
			method: 'PUT',
			body: { url: 'http://searxng:8080/search/' }
		});
		expect(res.status).toBe(200);
		expect(String(fetchMock.mock.calls[0][0])).toMatch(/^http:\/\/searxng:8080\/search\?/);
		expect(res.body).toMatchObject({
			searxng: { source: 'app', url: 'http://searxng:8080' },
			defaultProvider: 'searxng'
		});
	});

	it('refuses an instance without the JSON format and saves nothing', async () => {
		stubFetch({ status: 403, body: 'Forbidden', contentType: 'text/plain' });
		const res = await call<{ message: string }>(searxng.PUT, {
			method: 'PUT',
			body: { url: 'http://searxng:8080' }
		});
		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/search\.formats/);
		expect(getSetting(getDb(), 'websearch.searxng.url')).toBeUndefined();
	});

	it('rejects invalid URLs', async () => {
		stubFetch({ body: { results: [] } });
		const res = await call(searxng.PUT, { method: 'PUT', body: { url: 'file:///etc' } });
		expect(res.status).toBe(400);
	});

	it('returns 409 when SEARXNG_URL is set', async () => {
		config.SEARXNG_URL = 'http://env:8080';
		expect((await call(searxng.PUT, { method: 'PUT', body: { url: 'http://s' } })).status).toBe(
			409
		);
		expect((await call(searxng.DELETE, { method: 'DELETE' })).status).toBe(409);
	});

	it('removes the saved URL', async () => {
		stubFetch({ body: { results: [] } });
		await call(searxng.PUT, { method: 'PUT', body: { url: 'http://s' } });
		const res = await call(searxng.DELETE, { method: 'DELETE' });
		expect(res.body).toMatchObject({ searxng: { source: null, url: null } });
	});
});

describe('PUT /api/websearch/brave', () => {
	it('saves a working key, encrypted', async () => {
		const fetchMock = stubFetch({ body: { web: { results: [] } } });
		const res = await call(brave.PUT, { method: 'PUT', body: { apiKey: 'brave-abcd' } });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ brave: { source: 'app', hint: 'abcd' } });
		const init = fetchMock.mock.calls[0];
		expect(new Headers(init[1]?.headers).get('x-subscription-token')).toBe('brave-abcd');
		expect(getSetting<string>(getDb(), 'websearch.brave.apiKey')).not.toContain('brave-abcd');
	});

	it('rejects a key Brave turns down', async () => {
		stubFetch({ status: 401, body: {} });
		const res = await call<{ message: string }>(brave.PUT, {
			method: 'PUT',
			body: { apiKey: 'nope' }
		});
		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/rejected the API key/);
		expect(getSetting(getDb(), 'websearch.brave.apiKey')).toBeUndefined();
	});

	it('returns 409 when BRAVE_SEARCH_API_KEY is set', async () => {
		config.BRAVE_SEARCH_API_KEY = 'env-key';
		expect((await call(brave.PUT, { method: 'PUT', body: { apiKey: 'k' } })).status).toBe(409);
		expect((await call(brave.DELETE, { method: 'DELETE' })).status).toBe(409);
	});
});

describe('PUT /api/websearch/perplexity', () => {
	it('saves a working key, encrypted', async () => {
		const fetchMock = stubFetch({ body: { id: 'x', results: [] } });
		const res = await call(perplexity.PUT, { method: 'PUT', body: { apiKey: 'pplx-wxyz' } });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ perplexity: { source: 'app', hint: 'wxyz' } });
		const [input, init] = fetchMock.mock.calls[0];
		expect(String(input)).toBe('https://api.perplexity.ai/search');
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer pplx-wxyz');
		expect(getSetting<string>(getDb(), 'websearch.perplexity.apiKey')).not.toContain('pplx-wxyz');
	});

	it('rejects a key Perplexity turns down, and env-pinned keys', async () => {
		stubFetch({ status: 401, body: {} });
		const res = await call<{ message: string }>(perplexity.PUT, {
			method: 'PUT',
			body: { apiKey: 'nope' }
		});
		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/rejected the API key/);
		config.PERPLEXITY_API_KEY = 'env-key';
		const pinned = await call<{ message: string }>(perplexity.DELETE, { method: 'DELETE' });
		expect(pinned.status).toBe(409);
		expect(pinned.body.message).toMatch(/PERPLEXITY_API_KEY/);
	});
});

describe('unknown providers', () => {
	it('returns 404', async () => {
		const google = forProvider('google');
		expect((await call(google.PUT, { method: 'PUT', body: { apiKey: 'k' } })).status).toBe(404);
	});
});

describe('PUT /api/websearch/preferences', () => {
	async function connectBoth() {
		stubFetch({ body: { results: [], web: { results: [] } } });
		await call(searxng.PUT, { method: 'PUT', body: { url: 'http://s' } });
		await call(brave.PUT, { method: 'PUT', body: { apiKey: 'k' } });
	}

	it('saves the mode, the default and Backup only', async () => {
		await connectBoth();
		const res = await call(preferences.PUT, {
			method: 'PUT',
			body: { mode: 'fallback', defaultProvider: 'brave', backupOnly: ['searxng'] }
		});
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			mode: 'fallback',
			defaultProvider: 'brave',
			backupOnly: ['searxng'],
			order: { fallback: ['brave', 'searxng'], combined: ['brave'], backup: ['searxng'] }
		});
	});

	it('updates only the fields it is given', async () => {
		await connectBoth();
		await call(preferences.PUT, { method: 'PUT', body: { mode: 'fallback' } });
		const res = await call(preferences.PUT, { method: 'PUT', body: { backupOnly: ['brave'] } });
		expect(res.body).toMatchObject({ mode: 'fallback', backupOnly: ['brave'] });
	});

	it('saves nothing when any field is invalid', async () => {
		await connectBoth();
		for (const body of [
			{ mode: 'fallback', defaultProvider: 'perplexity' }, // not configured
			{ mode: 'fallback', defaultProvider: 'google' },
			{ mode: 'sometimes', backupOnly: ['brave'] },
			{ backupOnly: 'brave' },
			{ mode: 'fallback', extra: true }
		]) {
			expect((await call(preferences.PUT, { method: 'PUT', body })).status).toBe(400);
		}
		expect(getSetting(getDb(), 'websearch.mode')).toBeUndefined();
		expect(getSetting(getDb(), 'websearch.backupOnly')).toBeUndefined();
	});

	it('drops unknown ids and keeps unconfigured ones', async () => {
		await connectBoth();
		const res = await call(preferences.PUT, {
			method: 'PUT',
			body: { backupOnly: ['google', 'perplexity'] }
		});
		expect(res.body).toMatchObject({ backupOnly: ['perplexity'] });
	});
});
