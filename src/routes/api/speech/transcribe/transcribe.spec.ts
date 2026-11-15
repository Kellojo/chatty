import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

const { getDb } = await import('$lib/server/db/index.js');
const { createProvider } = await import('$lib/server/db/repo/providers.js');
const { createModel, setRoleDefault } = await import('$lib/server/db/repo/models.js');
const { POST } = await import('./+server.js');

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function call() {
	const form = new FormData();
	form.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'a.webm');
	const request = new Request('http://localhost/api/speech/transcribe', {
		method: 'POST',
		body: form
	});
	return POST({ request, locals: { user: { id: 'u1' } } } as never) as Promise<Response>;
}

describe('POST /api/speech/transcribe', () => {
	it('transcribes with the Speech to text default and logs the request', async () => {
		const db = getDb();
		const provider = createProvider(db, {
			name: 'speaches',
			type: 'openai-compatible',
			baseUrl: 'http://speaches.local/v1'
		});
		const model = createModel(db, {
			providerId: provider.id,
			modelId: 'whisper',
			capabilities: ['transcription']
		});
		setRoleDefault(db, 'speech-to-text', model.id);

		globalThis.fetch = vi.fn(async () => Response.json({ text: 'hello' })) as typeof fetch;
		const ok = await call();
		expect(await ok.json()).toEqual({ text: 'hello' });

		globalThis.fetch = vi.fn(async () =>
			Response.json({ error: { message: 'bad audio' } }, { status: 400 })
		) as typeof fetch;
		const failed = await call();
		expect(failed.status).toBe(400);

		const rows = db
			.prepare(
				"SELECT purpose, source, endpoint, status, http_status, provider_id, error FROM proxy_requests WHERE purpose = 'transcription' ORDER BY started_at, rowid"
			)
			.all();
		expect(rows).toEqual([
			{
				purpose: 'transcription',
				source: 'chat',
				endpoint: 'audio.transcriptions',
				status: 'complete',
				http_status: 200,
				provider_id: provider.id,
				error: null
			},
			{
				purpose: 'transcription',
				source: 'chat',
				endpoint: 'audio.transcriptions',
				status: 'failed',
				http_status: 400,
				provider_id: null,
				error: 'bad audio'
			}
		]);
	});
});
