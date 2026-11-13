import { describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.MEMORY_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-mem-stats-'));

const { getDb } = await import('$lib/server/db/index.js');
const { writeConcept } = await import('$lib/server/memory/bundle.js');
const { GET } = await import('./+server.js');

const audit = { author: 'user:u1', userId: 'u1' };

interface CallInit {
	user?: { id: string; role?: string } | null;
}

async function call<T = unknown>(
	handler: (event: never) => Response | Promise<Response>,
	init: CallInit = {}
): Promise<{ status: number; body: T }> {
	const url = new URL('http://localhost/api/memory/stats');
	const event = {
		locals: { user: init.user ?? null, session: null } as unknown as App.Locals,
		params: {},
		request: new Request(url, { method: 'GET' }),
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

describe('GET /api/memory/stats', () => {
	it('returns 401 without auth', async () => {
		const res = await call(GET, { user: null });
		expect(res.status).toBe(401);
	});

	it('returns zero when the user has no memories', async () => {
		const res = await call<{ count: number }>(GET, { user: u1 });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ count: 0 });
	});

	it('returns the concept count for the user', async () => {
		const db = getDb();
		await writeConcept(
			db,
			'user',
			'u1',
			'people/john.md',
			{ frontmatter: { title: 'John' }, body: 'John likes espresso.' },
			audit
		);
		await writeConcept(
			db,
			'user',
			'u1',
			'projects/ai-chat.md',
			{ frontmatter: { title: 'AI Chat' }, body: 'A project.' },
			audit
		);
		const res = await call<{ count: number }>(GET, { user: u1 });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ count: 2 });
	});
});
