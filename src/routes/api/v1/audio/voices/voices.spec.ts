import { describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

const { getDb } = await import('$lib/server/db/index.js');
const { createApiKey } = await import('$lib/server/db/repo/api-keys.js');
const { createProvider } = await import('$lib/server/db/repo/providers.js');
const { upsertFetchedModels } = await import('$lib/server/db/repo/models.js');
const { GET } = await import('./+server.js');

async function call(query: string, key: string) {
	const url = new URL(`http://localhost/api/v1/audio/voices${query}`);
	const request = new Request(url, { headers: { authorization: `Bearer ${key}` } });
	return GET({ request, url } as never);
}

describe('GET /v1/audio/voices', () => {
	it('lists a model’s voices in Kokoro-FastAPI’s shape', async () => {
		const db = getDb();
		db.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
			 VALUES ('u1', 'a@b.c', 'A', 0, 0, 0, 'user')`
		).run();
		const { rawKey } = await createApiKey(db, { userId: 'u1', label: 'k', scopes: ['llm:invoke'] });
		const provider = createProvider(db, {
			name: 'or',
			type: 'openai-compatible',
			baseUrl: 'https://or.example/v1'
		});
		upsertFetchedModels(db, provider.id, [
			{ id: 'kokoro', capabilities: ['speech'], voices: ['af_heart', 'am_adam'] }
		]);

		const res = await call('?model=kokoro', rawKey);
		expect(await res.json()).toEqual({
			voices: [
				{ id: 'af_heart', name: 'af_heart' },
				{ id: 'am_adam', name: 'am_adam' }
			],
			default_voice: null
		});
		expect((await call('', rawKey)).status).toBe(400);
		expect((await call('?model=nope', rawKey)).status).toBe(404);
		expect((await call('?model=kokoro', 'aic_wrong')).status).toBe(401);
	});
});
