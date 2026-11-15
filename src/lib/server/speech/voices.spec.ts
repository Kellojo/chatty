import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

const { getDb } = await import('$lib/server/db/index.js');
const { createProvider } = await import('$lib/server/db/repo/providers.js');
const { createModel, findModel, upsertFetchedModels } =
	await import('$lib/server/db/repo/models.js');
const { clearVoiceCache, listVoices, parseVoiceList, pickVoice } = await import('./voices.js');

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	clearVoiceCache();
});

describe('parseVoiceList', () => {
	it('reads Kokoro-FastAPI’s object and legacy string shapes', () => {
		expect(
			parseVoiceList({
				voices: [{ id: 'af_bella', name: 'af_bella' }, { id: 'af_heart' }],
				default_voice: 'af_heart'
			})
		).toEqual({ voices: ['af_bella', 'af_heart'], defaultVoice: 'af_heart' });
		expect(parseVoiceList({ voices: ['a', 'b'] })).toEqual({
			voices: ['a', 'b'],
			defaultVoice: null
		});
	});

	it('gives up on anything else', () => {
		expect(parseVoiceList({ voices: [] })).toBeNull();
		expect(parseVoiceList({ data: [] })).toBeNull();
		expect(parseVoiceList('nope')).toBeNull();
		// A default that isn't in the list is ignored.
		expect(parseVoiceList({ voices: ['a'], default_voice: 'z' })?.defaultVoice).toBeNull();
	});
});

describe('pickVoice', () => {
	const list = { voices: ['af_bella', 'af_heart'], defaultVoice: null };
	it('sends a requested voice as is', () => {
		expect(pickVoice('custom_blend', 'af_bella', list, 'alloy')).toBe('custom_blend');
	});
	it('uses the configured voice when the target offers it, else the target’s default', () => {
		expect(pickVoice(undefined, 'af_heart', list, 'alloy')).toBe('af_heart');
		expect(pickVoice(undefined, 'nova', list, 'alloy')).toBe('af_bella');
		expect(pickVoice(undefined, 'nova', { ...list, defaultVoice: 'af_heart' }, 'alloy')).toBe(
			'af_heart'
		);
		expect(
			pickVoice(undefined, '', { voices: ['echo', 'alloy'], defaultVoice: null }, 'alloy')
		).toBe('alloy');
	});
	it('trusts the configured voice when the list is unknown', () => {
		expect(pickVoice(undefined, 'nova', null, 'alloy')).toBe('nova');
		expect(pickVoice(undefined, '', null, 'alloy')).toBe('alloy');
	});
});

describe('listVoices', () => {
	it('prefers voices synced with the model, without asking the provider', async () => {
		const db = getDb();
		const provider = createProvider(db, {
			name: 'or',
			type: 'openai-compatible',
			baseUrl: 'https://or.example/v1'
		});
		upsertFetchedModels(db, provider.id, [
			{ id: 'kokoro', capabilities: ['speech'], voices: ['af_heart', 'am_adam'] }
		]);
		expect(findModel(db, provider.id, 'kokoro')?.voices).toBe('["af_heart","am_adam"]');
		globalThis.fetch = vi.fn() as typeof fetch;
		expect(await listVoices(db, { providerId: provider.id, modelId: 'kokoro' })).toEqual({
			voices: ['af_heart', 'am_adam'],
			defaultVoice: null
		});
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('asks the provider’s /audio/voices once, then remembers the answer', async () => {
		const db = getDb();
		const provider = createProvider(db, {
			name: 'kokoro-local',
			type: 'openai-compatible',
			baseUrl: 'http://kokoro.local/v1'
		});
		createModel(db, { providerId: provider.id, modelId: 'kokoro', capabilities: ['speech'] });
		globalThis.fetch = vi.fn(async () =>
			Response.json({ voices: [{ id: 'af_sky' }], default_voice: 'af_sky' })
		) as typeof fetch;
		const target = { providerId: provider.id, modelId: 'kokoro' };
		expect(await listVoices(db, target)).toEqual({ voices: ['af_sky'], defaultVoice: 'af_sky' });
		await listVoices(db, target);
		expect(globalThis.fetch).toHaveBeenCalledOnce();
		expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toBe(
			'http://kokoro.local/v1/audio/voices'
		);
	});

	it('retries a failed lookup soon instead of remembering it for long', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const db = getDb();
			const provider = createProvider(db, {
				name: 'slow-start',
				type: 'openai-compatible',
				baseUrl: 'http://speaches.local/v1'
			});
			createModel(db, { providerId: provider.id, modelId: 'kokoro', capabilities: ['speech'] });
			const target = { providerId: provider.id, modelId: 'kokoro' };
			globalThis.fetch = vi.fn(
				async () => new Response('loading', { status: 503 })
			) as typeof fetch;
			expect(await listVoices(db, target)).toBeNull();
			globalThis.fetch = vi.fn(async () => Response.json({ voices: ['af_heart'] })) as typeof fetch;
			// Still within the short retry window: the failure stands.
			expect(await listVoices(db, target)).toBeNull();
			vi.setSystemTime(Date.now() + 31_000);
			expect(await listVoices(db, target)).toEqual({ voices: ['af_heart'], defaultVoice: null });
		} finally {
			vi.useRealTimers();
		}
	});

	it('is unknown when the provider has no voice list', async () => {
		const db = getDb();
		const provider = createProvider(db, {
			name: 'openai',
			type: 'openai-compatible',
			baseUrl: 'https://api.openai.example/v1'
		});
		createModel(db, { providerId: provider.id, modelId: 'tts-1', capabilities: ['speech'] });
		globalThis.fetch = vi.fn(
			async () => new Response('Not found', { status: 404 })
		) as typeof fetch;
		expect(await listVoices(db, { providerId: provider.id, modelId: 'tts-1' })).toBeNull();
	});
});
