import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

const { getDb } = await import('$lib/server/db/index.js');
const { createApiKey } = await import('$lib/server/db/repo/api-keys.js');
const { createProvider } = await import('$lib/server/db/repo/providers.js');
const { createModel } = await import('$lib/server/db/repo/models.js');
const { createModelMapping } = await import('$lib/server/db/repo/model-mappings.js');
const { POST } = await import('./+server.js');

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe('POST /v1/audio/transcriptions', () => {
	it('falls back to the next mapping target when the primary fails', async () => {
		const db = getDb();
		db.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
			 VALUES ('u1', 'a@b.c', 'A', 0, 0, 0, 'user')`
		).run();
		const { rawKey } = await createApiKey(db, {
			userId: 'u1',
			label: 'k',
			scopes: ['llm:invoke']
		});
		const primary = createProvider(db, {
			name: 'p1',
			type: 'openai-compatible',
			baseUrl: 'https://primary.example/v1'
		});
		const backup = createProvider(db, {
			name: 'p2',
			type: 'openai-compatible',
			baseUrl: 'https://backup.example/v1'
		});
		for (const p of [primary, backup]) {
			createModel(db, { providerId: p.id, modelId: 'whisper', capabilities: ['transcription'] });
		}
		createModelMapping(db, {
			name: 'stt',
			targets: [
				{ providerId: primary.id, modelId: 'whisper' },
				{ providerId: backup.id, modelId: 'whisper' }
			]
		});

		const called: string[] = [];
		globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			called.push(url);
			if (url.startsWith('https://primary.example')) {
				return new Response('down', { status: 503 });
			}
			return Response.json({ text: 'hello' });
		}) as typeof fetch;

		const form = new FormData();
		form.append('model', 'stt');
		form.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'a.webm');
		const request = new Request('http://localhost/api/v1/audio/transcriptions', {
			method: 'POST',
			headers: { authorization: `Bearer ${rawKey}` },
			body: form
		});
		const res = await POST({ request } as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ text: 'hello' });
		expect(called).toEqual([
			'https://primary.example/v1/audio/transcriptions',
			'https://backup.example/v1/audio/transcriptions'
		]);
		const log = db.prepare('SELECT provider_id, fallback_index FROM proxy_requests').get() as {
			provider_id: string;
			fallback_index: number;
		};
		expect(log).toEqual({ provider_id: backup.id, fallback_index: 1 });
	});
});
