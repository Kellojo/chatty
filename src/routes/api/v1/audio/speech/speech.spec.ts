import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

const { getDb } = await import('$lib/server/db/index.js');
const { createApiKey } = await import('$lib/server/db/repo/api-keys.js');
const { createProvider } = await import('$lib/server/db/repo/providers.js');
const { createModel } = await import('$lib/server/db/repo/models.js');
const { createModelMapping } = await import('$lib/server/db/repo/model-mappings.js');
const { setDefaultVoice } = await import('$lib/server/speech/synthesizer.js');
const { POST } = await import('./+server.js');

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	setDefaultVoice(getDb(), '');
});

let rawKey = '';
let backupId = '';

beforeAll(async () => {
	const db = getDb();
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
		 VALUES ('u1', 'a@b.c', 'A', 0, 0, 0, 'user')`
	).run();
	({ rawKey } = await createApiKey(db, { userId: 'u1', label: 'k', scopes: ['llm:invoke'] }));
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
	backupId = backup.id;
	for (const p of [primary, backup]) {
		createModel(db, { providerId: p.id, modelId: 'tts-1', capabilities: ['speech'] });
	}
	createModel(db, { providerId: primary.id, modelId: 'gpt-chat', capabilities: ['chat'] });
	// Synced voice lists, so no test asks a provider for them.
	db.prepare('UPDATE models SET voices = ?').run(JSON.stringify(['alloy', 'af_heart', 'nova']));
	createModelMapping(db, {
		name: 'voice',
		targets: [
			{ providerId: primary.id, modelId: 'tts-1' },
			{ providerId: backup.id, modelId: 'tts-1' }
		]
	});
});

function speechRequest(body: unknown, key = rawKey): Request {
	return new Request('http://localhost/api/v1/audio/speech', {
		method: 'POST',
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

describe('POST /v1/audio/speech', () => {
	it('streams the audio and falls back to the next mapping target', async () => {
		const calls: { url: string; body: Record<string, unknown> }[] = [];
		globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, body: JSON.parse(String(init?.body)) });
			if (url.startsWith('https://primary.example')) return new Response('down', { status: 503 });
			return new Response(new Uint8Array([7, 8, 9]), {
				headers: { 'content-type': 'audio/mpeg' }
			});
		}) as typeof fetch;

		const res = await POST({ request: speechRequest({ model: 'voice', input: 'Hi' }) } as never);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('audio/mpeg');
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));
		expect(calls.map((c) => c.url)).toEqual([
			'https://primary.example/v1/audio/speech',
			'https://backup.example/v1/audio/speech'
		]);
		expect(calls[1].body).toEqual({
			model: 'tts-1',
			input: 'Hi',
			voice: 'alloy',
			response_format: 'mp3'
		});
		const log = getDb()
			.prepare(
				"SELECT provider_id, fallback_index, status FROM proxy_requests WHERE endpoint = 'audio.speech' ORDER BY started_at DESC LIMIT 1"
			)
			.get();
		expect(log).toEqual({ provider_id: backupId, fallback_index: 1, status: 'complete' });
	});

	it('uses the voice from Defaults unless the request names one', async () => {
		setDefaultVoice(getDb(), 'af_heart');
		const voices: unknown[] = [];
		globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			voices.push(JSON.parse(String(init?.body)).voice);
			return new Response(new Uint8Array([1]));
		}) as typeof fetch;

		await POST({ request: speechRequest({ model: 'tts-1', input: 'Hi' }) } as never);
		await POST({
			request: speechRequest({ model: 'tts-1', input: 'Hi', voice: 'nova' })
		} as never);
		expect(voices).toEqual(['af_heart', 'nova']);
	});

	it('reads with the model’s default when it does not offer the configured voice', async () => {
		setDefaultVoice(getDb(), 'shimmer');
		const voices: unknown[] = [];
		globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			voices.push(JSON.parse(String(init?.body)).voice);
			return new Response(new Uint8Array([1]));
		}) as typeof fetch;
		await POST({ request: speechRequest({ model: 'tts-1', input: 'Hi' }) } as never);
		expect(voices).toEqual(['alloy']);
	});

	it('rejects a model without the speech capability', async () => {
		globalThis.fetch = vi.fn() as typeof fetch;
		const res = await POST({ request: speechRequest({ model: 'gpt-chat', input: 'Hi' }) } as never);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
			'does not support text-to-speech'
		);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('does not try the next target when the request itself is refused', async () => {
		const called: string[] = [];
		globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
			called.push(String(input));
			return Response.json({ error: { message: 'Unknown voice: zzz' } }, { status: 400 });
		}) as typeof fetch;
		const res = await POST({
			request: speechRequest({ model: 'voice', input: 'Hi', voice: 'zzz' })
		} as never);
		expect(res.status).toBe(400);
		expect(called).toEqual(['https://primary.example/v1/audio/speech']);
	});

	it('names the provider when it cannot be reached', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new TypeError('fetch failed');
		}) as typeof fetch;
		const res = await POST({ request: speechRequest({ model: 'tts-1', input: 'Hi' }) } as never);
		expect(res.status).toBe(502);
		expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
			'Upstream error: Could not reach provider "p1": fetch failed'
		);
	});

	it('does not pass on the provider rejecting its key as the caller’s 401', async () => {
		globalThis.fetch = vi.fn(async () =>
			Response.json({ error: { message: 'Invalid API key' } }, { status: 401 })
		) as typeof fetch;
		const res = await POST({ request: speechRequest({ model: 'tts-1', input: 'Hi' }) } as never);
		expect(res.status).toBe(502);
		expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
			'Upstream error: Provider rejected the request: Invalid API key'
		);
	});

	it('validates the body and the key', async () => {
		const empty = await POST({ request: speechRequest({ model: 'tts-1', input: '' }) } as never);
		expect(empty.status).toBe(400);
		const tooLong = await POST({
			request: speechRequest({ model: 'tts-1', input: 'a'.repeat(4097) })
		} as never);
		expect(tooLong.status).toBe(400);
		const unknown = await POST({ request: speechRequest({ model: 'nope', input: 'Hi' }) } as never);
		expect(unknown.status).toBe(404);
		const noKey = await POST({
			request: speechRequest({ model: 'tts-1', input: 'Hi' }, 'aic_wrong')
		} as never);
		expect(noKey.status).toBe(401);
	});
});
