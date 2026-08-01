import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadModules() {
	vi.resetModules();
	process.env.DATABASE_PATH = ':memory:';
	process.env.APP_SECRET = 'test-secret-test-secret';
	const [{ getDb }, providers, models, registry] = await Promise.all([
		import('../db/index.js'),
		import('../db/repo/providers.js'),
		import('../db/repo/models.js'),
		import('./registry.js')
	]);
	return { db: getDb(), providers, models, registry };
}

describe('llm registry', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Promise.resolve(
					new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }), { status: 200 })
				)
			)
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('resolveModel returns a language model for an enabled provider+model', async () => {
		const { db, providers, models, registry } = await loadModules();
		const p = providers.createProvider(db, { name: 'A', type: 'anthropic', apiKey: 'sk' });
		models.createModel(db, { providerId: p.id, modelId: 'claude-test' });
		const model = registry.resolveModel({ providerId: p.id, modelId: 'claude-test' });
		expect((model as { modelId: string }).modelId).toBe('claude-test');
	});

	it('resolveModel throws for disabled providers and unknown models', async () => {
		const { db, providers, models, registry } = await loadModules();
		const p = providers.createProvider(db, { name: 'A', type: 'anthropic' });
		models.createModel(db, { providerId: p.id, modelId: 'x' });
		providers.updateProvider(db, p.id, { enabled: false });
		expect(() => registry.resolveModel({ providerId: p.id, modelId: 'x' })).toThrow(
			registry.ModelUnavailableError
		);
		providers.updateProvider(db, p.id, { enabled: true });
		expect(() => registry.resolveModel({ providerId: p.id, modelId: 'nope' })).toThrow(
			registry.ModelUnavailableError
		);
	});

	it('roleModel resolves the enabled default for a role', async () => {
		const { db, providers, models, registry } = await loadModules();
		expect(() => registry.roleModel('chat')).toThrow(registry.ModelUnavailableError);
		const p = providers.createProvider(db, { name: 'A', type: 'anthropic' });
		const m = models.createModel(db, { providerId: p.id, modelId: 'chatty' });
		models.setRoleDefault(db, 'chat', m.id);
		expect((registry.roleModel('chat') as { modelId: string }).modelId).toBe('chatty');
	});

	it('listModelsGrouped groups enabled models under enabled providers', async () => {
		const { db, providers, models, registry } = await loadModules();
		const p = providers.createProvider(db, { name: 'A', type: 'anthropic' });
		models.createModel(db, { providerId: p.id, modelId: 'on' });
		models.createModel(db, { providerId: p.id, modelId: 'off', enabled: false });
		const groups = registry.listModelsGrouped();
		expect(groups).toHaveLength(1);
		expect(groups[0].models.map((m) => m.modelId)).toEqual(['on']);
		providers.updateProvider(db, p.id, { enabled: false });
		expect(registry.listModelsGrouped()).toHaveLength(0);
	});

	it('fetchProviderModels probes openai-compatible /models with the decrypted key', async () => {
		const { db, providers, registry } = await loadModules();
		const p = providers.createProvider(db, {
			name: 'Local',
			type: 'openai-compatible',
			baseUrl: 'http://localhost:1234/v1',
			apiKey: 'sk-local'
		});
		const fetched = await registry.fetchProviderModels(p.id);
		expect(fetched.map((m) => m.id)).toEqual(['m1', 'm2']);
		const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
		expect(url).toBe('http://localhost:1234/v1/models');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-local');
	});

	it('fetchProviderModels parses OpenRouter-style pricing into USD per 1M tokens', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							data: [
								{
									id: 'or-model',
									architecture: { input_modalities: ['text'], output_modalities: ['text'] },
									pricing: { prompt: '0.00000015', completion: '0.0000006' },
									context_length: 128000
								},
								{
									id: 'image-model',
									architecture: { input_modalities: ['text'], output_modalities: ['image'] }
								},
								{
									id: 'vision-model',
									architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }
								},
								{ id: 'free-model', pricing: { prompt: '0', completion: '0' } },
								{ id: 'plain-model' }
							]
						}),
						{ status: 200 }
					)
				)
			)
		);
		const { db, providers, registry } = await loadModules();
		const p = providers.createProvider(db, {
			name: 'OR',
			type: 'openai-compatible',
			baseUrl: 'https://openrouter.ai/api/v1',
			apiKey: 'sk-or'
		});
		const fetched = await registry.fetchProviderModels(p.id);
		expect(fetched).toEqual([
			{
				id: 'or-model',
				capabilities: ['chat', 'streaming'],
				priceInput: 0.15,
				priceOutput: 0.6,
				contextLength: 128000
			},
			{
				id: 'image-model',
				capabilities: ['chat', 'streaming', 'image'],
				priceInput: null,
				priceOutput: null,
				contextLength: null
			},
			{
				id: 'vision-model',
				capabilities: ['chat', 'streaming', 'vision'],
				priceInput: null,
				priceOutput: null,
				contextLength: null
			},
			{
				id: 'free-model',
				capabilities: ['chat', 'streaming'],
				priceInput: null,
				priceOutput: null,
				contextLength: null
			},
			{
				id: 'plain-model',
				capabilities: ['chat', 'streaming'],
				priceInput: null,
				priceOutput: null,
				contextLength: null
			}
		]);
	});

	it('fetchProviderModels requires a key for anthropic', async () => {
		const { db, providers, registry } = await loadModules();
		const p = providers.createProvider(db, { name: 'A', type: 'anthropic' });
		await expect(registry.fetchProviderModels(p.id)).rejects.toThrow('requires an API key');
	});
});
