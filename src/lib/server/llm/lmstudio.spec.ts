import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadModules() {
	vi.resetModules();
	process.env.DATABASE_PATH = ':memory:';
	process.env.APP_SECRET = 'test-secret-test-secret';
	const [{ getDb }, providers, models, lmstudio, registry] = await Promise.all([
		import('../db/index.js'),
		import('../db/repo/providers.js'),
		import('../db/repo/models.js'),
		import('./lmstudio.js'),
		import('./registry.js')
	]);
	return { db: getDb(), providers, models, lmstudio, registry };
}

const V1_BODY = {
	models: [
		{
			key: 'qwen/qwen3-8b',
			max_context_length: 131072,
			loaded_instances: [{ id: 'qwen/qwen3-8b', config: { context_length: 16384 } }]
		},
		{ key: 'google/gemma', max_context_length: 262144, loaded_instances: [] }
	]
};

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

describe('lmstudio', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn(async (url: string) => {
			if (url.endsWith('/api/v1/models')) return json(V1_BODY);
			if (url.endsWith('/v1/models'))
				return json({ data: [{ id: 'qwen/qwen3-8b' }, { id: 'google/gemma' }] });
			return json({}, 404);
		});
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('recognises LM Studio by name or port', async () => {
		const { db, providers, lmstudio } = await loadModules();
		const byName = providers.createProvider(db, {
			name: 'LM Studio',
			type: 'openai-compatible',
			baseUrl: 'http://10.0.0.2:9000/v1'
		});
		const byPort = providers.createProvider(db, {
			name: 'Desk',
			type: 'openai-compatible',
			baseUrl: 'http://10.0.0.2:1234/v1'
		});
		const other = providers.createProvider(db, {
			name: 'Openrouter',
			type: 'openai-compatible',
			baseUrl: 'https://openrouter.ai/api/v1'
		});
		const rows = [byName, byPort, other].map((p) => providers.getProvider(db, p.id)!);
		expect(rows.map((r) => lmstudio.isLmStudioProvider(r))).toEqual([true, true, false]);
	});

	it('reads the loaded context from the native API, null when not loaded', async () => {
		const { db, providers, lmstudio } = await loadModules();
		const p = providers.createProvider(db, {
			name: 'LM Studio',
			type: 'openai-compatible',
			baseUrl: 'http://lm:1234/v1/'
		});
		const row = providers.getProvider(db, p.id)!;
		expect(await lmstudio.liveContextLength(row, 'qwen/qwen3-8b')).toBe(16384);
		expect(await lmstudio.liveContextLength(row, 'google/gemma')).toBeNull();
		expect(fetchMock).toHaveBeenCalledWith('http://lm:1234/api/v1/models', expect.anything());
		// cached per provider
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('falls back to the v0 API on older servers', async () => {
		fetchMock.mockImplementation(async (url: string) =>
			url.endsWith('/api/v0/models')
				? json({
						data: [
							{ id: 'a', state: 'loaded', max_context_length: 32768, loaded_context_length: 8192 },
							{ id: 'b', state: 'not-loaded', max_context_length: 32768 }
						]
					})
				: json({}, 404)
		);
		const { db, providers, lmstudio } = await loadModules();
		const p = providers.createProvider(db, {
			name: 'LM Studio',
			type: 'openai-compatible',
			baseUrl: 'http://lm:1234/v1'
		});
		const models = await lmstudio.fetchLmStudioModels(providers.getProvider(db, p.id)!);
		expect(models).toEqual([
			{ id: 'a', maxContextLength: 32768, loadedContextLength: 8192 },
			{ id: 'b', maxContextLength: 32768, loadedContextLength: null }
		]);
	});

	it('effectiveContextLength prefers the live value, else the stored one', async () => {
		const { db, providers, models, lmstudio } = await loadModules();
		const p = providers.createProvider(db, {
			name: 'LM Studio',
			type: 'openai-compatible',
			baseUrl: 'http://lm:1234/v1'
		});
		const loaded = models.createModel(db, { providerId: p.id, modelId: 'qwen/qwen3-8b' });
		models.updateModel(db, loaded.id, { contextLength: 4096 });
		const idle = models.createModel(db, { providerId: p.id, modelId: 'google/gemma' });
		models.updateModel(db, idle.id, { contextLength: 8192 });

		expect(
			await lmstudio.effectiveContextLength({ providerId: p.id, modelId: 'qwen/qwen3-8b' })
		).toBe(16384);
		expect(
			await lmstudio.effectiveContextLength({ providerId: p.id, modelId: 'google/gemma' })
		).toBe(8192);
	});

	it('uses the stored value when the server is unreachable', async () => {
		fetchMock.mockRejectedValue(new TypeError('fetch failed'));
		const { db, providers, models, lmstudio } = await loadModules();
		const p = providers.createProvider(db, {
			name: 'LM Studio',
			type: 'openai-compatible',
			baseUrl: 'http://lm:1234/v1'
		});
		const m = models.createModel(db, { providerId: p.id, modelId: 'x' });
		models.updateModel(db, m.id, { contextLength: 12000 });
		expect(await lmstudio.effectiveContextLength({ providerId: p.id, modelId: 'x' })).toBe(12000);
	});

	it('model sync stores the loaded context, not the trained maximum', async () => {
		const { db, providers, registry } = await loadModules();
		const p = providers.createProvider(db, {
			name: 'LM Studio',
			type: 'openai-compatible',
			baseUrl: 'http://lm:1234/v1'
		});
		const fetched = await registry.fetchProviderModels(p.id);
		expect(fetched.map((m) => [m.id, m.contextLength])).toEqual([
			['qwen/qwen3-8b', 16384],
			['google/gemma', null]
		]);
	});
});
