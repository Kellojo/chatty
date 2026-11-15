import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

const { getDb } = await import('$lib/server/db/index.js');
const { createProvider } = await import('$lib/server/db/repo/providers.js');
const { createModel, setRoleDefault } = await import('$lib/server/db/repo/models.js');
const { POST } = await import('./+server.js');

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

let modelRowId = '';
beforeAll(() => {
	const db = getDb();
	const provider = createProvider(db, {
		name: 'openai',
		type: 'openai-compatible',
		baseUrl: 'https://tts.example/v1'
	});
	modelRowId = createModel(db, {
		providerId: provider.id,
		modelId: 'tts-1',
		capabilities: ['speech']
	}).id;
	// A synced voice list, so no test asks the provider for one.
	db.prepare('UPDATE models SET voices = ?').run(JSON.stringify(['alloy']));
});

const user = { id: 'u1' };

function call(text: string, locals: object = { user }) {
	const request = new Request('http://localhost/api/speech/synthesize', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ text })
	});
	return Promise.resolve(POST({ request, locals } as never));
}

/** The status of a thrown SvelteKit `error()`, or of the returned response. */
async function statusOf(promise: Promise<Response>): Promise<{ status: number; message?: string }> {
	try {
		return { status: (await promise).status };
	} catch (e) {
		const err = e as { status: number; body?: { message?: string } };
		return { status: err.status, message: err.body?.message };
	}
}

describe('POST /api/speech/synthesize', () => {
	it('needs a signed-in user and a Text to speech default', async () => {
		expect((await statusOf(call('Hi', {}))).status).toBe(401);
		expect(await statusOf(call('Hi'))).toEqual({
			status: 409,
			message: 'No text to speech model is set'
		});
	});

	it('streams the role model’s audio', async () => {
		setRoleDefault(getDb(), 'text-to-speech', modelRowId);
		globalThis.fetch = vi.fn(
			async () =>
				new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } })
		) as typeof fetch;
		const res = await call('Hello there.');
		expect(res.headers.get('content-type')).toBe('audio/mpeg');
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
	});

	it('logs each read-aloud request in the requests log', async () => {
		setRoleDefault(getDb(), 'text-to-speech', modelRowId);
		globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1]))) as typeof fetch;
		await call('Logged.');
		const row = getDb()
			.prepare(
				"SELECT endpoint, purpose, source, status, user_id, model_id FROM proxy_requests WHERE purpose = 'speech' ORDER BY started_at DESC, rowid DESC LIMIT 1"
			)
			.get();
		expect(row).toEqual({
			endpoint: 'audio.speech',
			purpose: 'speech',
			source: 'chat',
			status: 'complete',
			user_id: 'u1',
			model_id: 'tts-1'
		});
	});

	it('reads with a requested voice, e.g. for a preview', async () => {
		setRoleDefault(getDb(), 'text-to-speech', modelRowId);
		const sent: unknown[] = [];
		globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			sent.push(JSON.parse(String(init?.body)).voice);
			return new Response(new Uint8Array([1]));
		}) as typeof fetch;
		const request = new Request('http://localhost/api/speech/synthesize', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text: 'Hi', voice: 'af_bella' })
		});
		await POST({ request, locals: { user } } as never);
		expect(sent).toEqual(['af_bella']);
	});

	it('reports a provider rejecting its key as a 502, not a session error', async () => {
		setRoleDefault(getDb(), 'text-to-speech', modelRowId);
		globalThis.fetch = vi.fn(async () =>
			Response.json({ error: { message: 'Invalid API key' } }, { status: 401 })
		) as typeof fetch;
		expect(await statusOf(call('Hi'))).toEqual({
			status: 502,
			message: 'Provider rejected the request: Invalid API key'
		});
	});

	it('caps how many requests one user has waiting', async () => {
		setRoleDefault(getDb(), 'text-to-speech', modelRowId);
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		globalThis.fetch = vi.fn(async () => {
			await gate;
			return new Response(new Uint8Array([1]));
		}) as typeof fetch;
		const pending = [call('a'), call('b'), call('c')];
		expect(await statusOf(call('d'))).toEqual({
			status: 429,
			message: 'Too many speech requests at once'
		});
		release();
		const settled = await Promise.all(pending.map(statusOf));
		expect(settled.map((s) => s.status)).toEqual([200, 200, 200]);
		// Slots free up once requests finish.
		expect((await statusOf(call('e'))).status).toBe(200);
	});

	it('frees the slot and skips fallbacks when the client cancels', async () => {
		setRoleDefault(getDb(), 'text-to-speech', modelRowId);
		const seen: AbortSignal[] = [];
		globalThis.fetch = vi.fn(
			(_input: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_, reject) => {
					seen.push(init!.signal!);
					init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
				})
		) as typeof fetch;
		const controllers = [new AbortController(), new AbortController(), new AbortController()];
		const pending = controllers.map((c) => {
			const request = new Request('http://localhost/api/speech/synthesize', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text: 'Hi' }),
				signal: c.signal
			});
			return statusOf(Promise.resolve(POST({ request, locals: { user } } as never)));
		});
		await new Promise((r) => setTimeout(r, 0));
		for (const c of controllers) c.abort();
		await Promise.all(pending);
		expect(seen).toHaveLength(3);
		expect(seen.every((s) => s.aborted)).toBe(true);
		// All three slots are free again.
		globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1]))) as typeof fetch;
		expect((await statusOf(call('again'))).status).toBe(200);
	});
});
