import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

// No real DNS: public names resolve to a public address, `*.lan` to a LAN one.
vi.mock('node:dns/promises', () => ({
	lookup: vi.fn(async (host: string) => {
		if (host.endsWith('.lan')) return [{ address: '192.168.1.20', family: 4 }];
		if (host === 'unresolvable.example') throw new Error('ENOTFOUND');
		return [{ address: '93.184.216.34', family: 4 }];
	})
}));

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { getProvider } = await import('$lib/server/db/repo/providers.js');
const { POST } = await import('./+server.js');
const { PATCH } = await import('./[id]/+server.js');
const { GET: locality } = await import('./locality/+server.js');

type Provider = import('$lib/types.js').Provider;

const admin = { id: 'admin', role: 'admin' };
const user = { id: 'u1', role: 'user' };

async function call<T = unknown>(
	handler: (event: never) => Response | Promise<Response>,
	init: {
		user: { id: string; role: string };
		method?: string;
		url?: string;
		params?: Record<string, string>;
		body?: unknown;
	}
): Promise<{ status: number; body: T }> {
	const url = new URL(init.url ?? 'http://localhost/api/providers');
	const method = init.method ?? (init.params ? 'PATCH' : 'POST');
	const event = {
		locals: { user: init.user, session: null } as unknown as App.Locals,
		params: init.params ?? {},
		request: new Request(url, {
			method,
			headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
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

beforeEach(() => {
	closeDb();
});

describe('provider allowPrivate', () => {
	it('creates untrusted providers unless allowPrivate is set', async () => {
		const plain = await call<{ provider: Provider }>(POST, {
			user: admin,
			body: { name: 'Anthropic', type: 'anthropic', apiKey: 'sk' }
		});
		expect(plain.status).toBe(201);
		expect(plain.body.provider.allowPrivate).toBe(false);
		expect(getProvider(getDb(), plain.body.provider.id)!.allow_private).toBe(0);

		const trusted = await call<{ provider: Provider }>(POST, {
			user: admin,
			body: {
				name: 'LM Studio',
				type: 'openai-compatible',
				baseUrl: 'http://localhost:1234/v1',
				allowPrivate: true
			}
		});
		expect(trusted.body.provider.allowPrivate).toBe(true);
		expect(getProvider(getDb(), trusted.body.provider.id)!.allow_private).toBe(1);
	});

	it('toggles on update and keeps it when the patch leaves it out', async () => {
		const created = await call<{ provider: Provider }>(POST, {
			user: admin,
			body: { name: 'P', type: 'anthropic' }
		});
		const id = created.body.provider.id;
		const on = await call<{ provider: Provider }>(PATCH, {
			user: admin,
			params: { id },
			body: { allowPrivate: true }
		});
		expect(on.body.provider.allowPrivate).toBe(true);
		const renamed = await call<{ provider: Provider }>(PATCH, {
			user: admin,
			params: { id },
			body: { name: 'Q' }
		});
		expect(renamed.body.provider.allowPrivate).toBe(true);
		const off = await call<{ provider: Provider }>(PATCH, {
			user: admin,
			params: { id },
			body: { allowPrivate: false }
		});
		expect(off.body.provider.allowPrivate).toBe(false);
	});

	it('is admin-only', async () => {
		const res = await call(POST, {
			user,
			body: { name: 'P', type: 'anthropic', allowPrivate: true }
		});
		expect(res.status).toBe(403);
	});
});

describe('GET /api/providers/locality', () => {
	const check = (target: string, name?: string, who = admin) => {
		const url = new URL('http://localhost/api/providers/locality');
		url.searchParams.set('url', target);
		if (name) url.searchParams.set('name', name);
		return call<{ looksLocal: boolean; host: string | null }>(locality, {
			user: who,
			method: 'GET',
			url: url.href
		});
	};

	it('says localhost looks local', async () => {
		const res = await check('http://localhost:1234/v1');
		expect(res.body).toEqual({ looksLocal: true, host: 'localhost' });
	});

	it('says a public API does not look local', async () => {
		const res = await check('https://api.openai.com/v1');
		expect(res.body).toEqual({ looksLocal: false, host: 'api.openai.com' });
	});

	it('judges by resolved addresses, IP literals and .local names', async () => {
		expect((await check('http://gpu-box.lan:8080/v1')).body.looksLocal).toBe(true);
		expect((await check('http://10.0.0.5:8000/v1')).body.looksLocal).toBe(true);
		expect((await check('http://[::1]:8000/v1')).body).toEqual({ looksLocal: true, host: '::1' });
		expect((await check('http://studio.local/v1')).body.looksLocal).toBe(true);
		expect((await check('https://unresolvable.example/v1')).body.looksLocal).toBe(false);
	});

	it('treats Ollama and LM Studio as local', async () => {
		expect((await check('http://gpu.example.com:11434/v1')).body.looksLocal).toBe(true);
		expect((await check('https://models.example.com/v1', 'LM Studio')).body.looksLocal).toBe(true);
	});

	it('handles a missing or invalid url', async () => {
		const res = await call<{ looksLocal: boolean; host: string | null }>(locality, {
			user: admin,
			method: 'GET',
			url: 'http://localhost/api/providers/locality?url=not-a-url'
		});
		expect(res.body).toEqual({ looksLocal: false, host: null });
	});

	it('is admin-only', async () => {
		const res = await check('http://localhost:1234/v1', undefined, user);
		expect(res.status).toBe(403);
	});
});
