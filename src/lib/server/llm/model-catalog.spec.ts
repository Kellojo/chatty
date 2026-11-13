import { describe, expect, it, vi } from 'vitest';

async function loadModules() {
	vi.resetModules();
	process.env.DATABASE_PATH = ':memory:';
	process.env.APP_SECRET = 'test-secret-test-secret';
	const [{ getDb }, providers, models, catalog] = await Promise.all([
		import('../db/index.js'),
		import('../db/repo/providers.js'),
		import('../db/repo/models.js'),
		import('./model-catalog.js')
	]);
	return { db: getDb(), providers, models, catalog };
}

describe('model catalog', () => {
	it('lists enabled models with only the fields pickers use', async () => {
		const { db, providers, models, catalog } = await loadModules();
		const p = providers.createProvider(db, { name: 'A', type: 'anthropic', apiKey: 'sk' });
		models.createModel(db, { providerId: p.id, modelId: 'on', displayName: 'On' });
		models.createModel(db, { providerId: p.id, modelId: 'off', enabled: false });
		const { groups } = catalog.getModelCatalog();
		expect(groups).toEqual([
			{
				provider: { id: p.id, name: 'A', type: 'anthropic', baseUrl: null },
				models: [
					{
						providerId: p.id,
						modelId: 'on',
						displayName: 'On',
						capabilities: expect.any(Array)
					}
				]
			}
		]);
	});

	it('keeps its version until the models change', async () => {
		const { db, providers, models, catalog } = await loadModules();
		const p = providers.createProvider(db, { name: 'A', type: 'anthropic' });
		const m = models.createModel(db, { providerId: p.id, modelId: 'one' });
		const first = catalog.getModelCatalog().version;
		expect(catalog.getModelCatalog().version).toBe(first);
		models.updateModel(db, m.id, { displayName: 'Renamed' });
		expect(catalog.getModelCatalog().version).not.toBe(first);
	});

	it('sends the models themselves only on a full page load', async () => {
		const { db, providers, models, catalog } = await loadModules();
		const p = providers.createProvider(db, { name: 'A', type: 'anthropic' });
		models.createModel(db, { providerId: p.id, modelId: 'one' });
		models.createModel(db, { providerId: p.id, modelId: 'two' });
		const full = catalog.modelCatalogInfo(false);
		const data = catalog.modelCatalogInfo(true);
		expect(full.groups?.[0].models).toHaveLength(2);
		expect(data).toEqual({ version: full.version, count: 2 });
	});
});
