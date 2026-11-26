import { describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { strFromU8, unzipSync } from 'fflate';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.MEMORY_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-mem-export-'));

const { getDb } = await import('$lib/server/db/index.js');
const { writeConcept } = await import('$lib/server/memory/bundle.js');
const { GET } = await import('./+server.js');

async function call(
	user: { id: string; role?: string } | null,
	query = ''
): Promise<{ status: number; res?: Response }> {
	const url = new URL(`http://localhost/api/memory/export${query}`);
	const event = {
		locals: { user, session: null } as unknown as App.Locals,
		params: {},
		request: new Request(url, { method: 'GET' }),
		url
	};
	try {
		const res = await GET(event as never);
		return { status: res.status, res };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status };
		throw e;
	}
}

async function unzip(res: Response): Promise<Record<string, string>> {
	const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
	return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strFromU8(v)]));
}

const u1 = { id: 'u1', role: 'user' };
const admin = { id: 'a1', role: 'admin' };

describe('GET /api/memory/export', () => {
	it('returns 401 without auth', async () => {
		expect((await call(null)).status).toBe(401);
	});

	it('refuses shared memory to non-admins', async () => {
		expect((await call(u1, '?scope=shared')).status).toBe(403);
	});

	it("zips the user's concepts, private ones included, and nobody else's", async () => {
		const db = getDb();
		await writeConcept(
			db,
			'user',
			'u1',
			'people/john.md',
			{ frontmatter: { title: 'John' }, body: 'John likes espresso.' },
			{ author: 'user:u1', userId: 'u1' }
		);
		await writeConcept(
			db,
			'user',
			'u1',
			'health.md',
			{ frontmatter: { title: 'Health', private: true }, body: 'Allergic to nuts.' },
			{ author: 'user:u1', userId: 'u1' }
		);
		await writeConcept(
			db,
			'user',
			'u2',
			'other.md',
			{ frontmatter: { title: 'Other' }, body: 'Not u1.' },
			{ author: 'user:u2', userId: 'u2' }
		);

		const { status, res } = await call(u1);
		expect(status).toBe(200);
		expect(res!.headers.get('content-type')).toBe('application/zip');
		expect(res!.headers.get('content-disposition')).toMatch(
			/^attachment; filename="chatty-memory-\d{4}-\d{2}-\d{2}\.zip"$/
		);
		const files = await unzip(res!);
		expect(Object.keys(files).sort()).toEqual(['health.md', 'people/john.md']);
		expect(files['people/john.md']).toContain('John likes espresso.');
		expect(files['health.md']).toContain('private: true');
	});

	it('exports shared memory for admins', async () => {
		await writeConcept(
			getDb(),
			'shared',
			'a1',
			'team.md',
			{ frontmatter: { title: 'Team' }, body: 'Shared note.' },
			{ author: 'user:a1', userId: 'a1' }
		);
		const { status, res } = await call(admin, '?scope=shared');
		expect(status).toBe(200);
		expect(res!.headers.get('content-disposition')).toContain('chatty-shared-memory-');
		expect(Object.keys(await unzip(res!))).toEqual(['team.md']);
	});

	it('returns an empty archive when there is no memory', async () => {
		const { status, res } = await call({ id: 'nobody', role: 'user' });
		expect(status).toBe(200);
		expect(await unzip(res!)).toEqual({});
	});
});
