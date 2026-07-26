import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../index.js';
import { createProvider } from './providers.js';
import {
	createModel,
	findEnabledModelByModelId,
	findModel,
	findRoleModel,
	listEnabledModels,
	listRoleDefaults,
	setRoleDefault,
	updateModel,
	upsertFetchedModels
} from './models.js';

let db: Db;
let providerId: string;

beforeEach(() => {
	db = openDatabase(':memory:');
	providerId = createProvider(db, { name: 'P', type: 'anthropic' }).id;
});

describe('models repo', () => {
	it('upsertFetchedModels inserts only missing models', () => {
		expect(upsertFetchedModels(db, providerId, [{ id: 'a' }, { id: 'b' }])).toEqual({
			added: 2,
			total: 2
		});
		expect(upsertFetchedModels(db, providerId, [{ id: 'b' }, { id: 'c' }])).toEqual({
			added: 1,
			total: 2
		});
	});

	it('upsertFetchedModels fully syncs provider pricing, clearing it when absent', () => {
		upsertFetchedModels(db, providerId, [{ id: 'a', priceInput: 1.5, priceOutput: 6 }]);
		let row = findModel(db, providerId, 'a')!;
		expect(row.price_input).toBe(1.5);
		expect(row.price_output).toBe(6);

		upsertFetchedModels(db, providerId, [{ id: 'a', priceInput: 2 }]);
		row = findModel(db, providerId, 'a')!;
		expect(row.price_input).toBe(2);
		expect(row.price_output).toBeNull();

		upsertFetchedModels(db, providerId, [{ id: 'a' }]);
		row = findModel(db, providerId, 'a')!;
		expect(row.price_input).toBeNull();
		expect(row.price_output).toBeNull();
	});

	it('upsertFetchedModels unions fetched capabilities into existing ones without removing any', () => {
		upsertFetchedModels(db, providerId, [{ id: 'a', capabilities: ['chat', 'streaming'] }]);
		let row = findModel(db, providerId, 'a')!;
		expect(JSON.parse(row.capabilities)).toEqual(['chat', 'streaming']);

		upsertFetchedModels(db, providerId, [{ id: 'a', capabilities: ['chat', 'vision', 'image'] }]);
		row = findModel(db, providerId, 'a')!;
		expect(JSON.parse(row.capabilities)).toEqual(['chat', 'streaming', 'vision', 'image']);

		// A fetch reporting fewer capabilities must not strip ones already stored.
		upsertFetchedModels(db, providerId, [{ id: 'a', capabilities: ['chat'] }]);
		row = findModel(db, providerId, 'a')!;
		expect(JSON.parse(row.capabilities)).toEqual(['chat', 'streaming', 'vision', 'image']);

		// A fetch with no capability info leaves capabilities untouched.
		upsertFetchedModels(db, providerId, [{ id: 'a' }]);
		row = findModel(db, providerId, 'a')!;
		expect(JSON.parse(row.capabilities)).toEqual(['chat', 'streaming', 'vision', 'image']);
	});

	it('updateModel sets and clears manual pricing', () => {
		const m = createModel(db, { providerId, modelId: 'one' });
		expect(m.price_input).toBeNull();

		updateModel(db, m.id, { priceInput: 0.25, priceOutput: 1 });
		let row = findModel(db, providerId, 'one')!;
		expect(row.price_input).toBe(0.25);
		expect(row.price_output).toBe(1);

		updateModel(db, m.id, { displayName: 'One' });
		row = findModel(db, providerId, 'one')!;
		expect(row.price_input).toBe(0.25);

		updateModel(db, m.id, { priceInput: null });
		row = findModel(db, providerId, 'one')!;
		expect(row.price_input).toBeNull();
		expect(row.price_output).toBe(1);
	});

	it('setRoleDefault assigns one model per role and allows reuse across roles', () => {
		const m1 = createModel(db, { providerId, modelId: 'one' });
		const m2 = createModel(db, { providerId, modelId: 'two' });
		setRoleDefault(db, 'chat', m1.id);
		setRoleDefault(db, 'chat', m2.id);
		expect(findRoleModel(db, 'chat')!.id).toBe(m2.id);
		setRoleDefault(db, 'memory', m2.id);
		expect(findRoleModel(db, 'memory')!.id).toBe(m2.id);
		expect(listRoleDefaults(db)).toEqual({ chat: m2.id, memory: m2.id });
		setRoleDefault(db, 'chat', null);
		expect(findRoleModel(db, 'chat')).toBeUndefined();
		expect(findRoleModel(db, 'memory')!.id).toBe(m2.id);
	});

	it('role + enabled lookups skip disabled models and providers', () => {
		const m = createModel(db, { providerId, modelId: 'one' });
		setRoleDefault(db, 'memory', m.id);
		expect(findRoleModel(db, 'memory')!.id).toBe(m.id);

		db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(m.id);
		expect(findRoleModel(db, 'memory')).toBeUndefined();
		expect(listEnabledModels(db)).toHaveLength(0);

		db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(m.id);
		db.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(providerId);
		expect(findRoleModel(db, 'memory')).toBeUndefined();
		expect(listEnabledModels(db)).toHaveLength(0);
	});

	it('findEnabledModelByModelId resolves across providers and skips disabled rows', () => {
		expect(findEnabledModelByModelId(db, 'one')).toBeUndefined();

		const m = createModel(db, { providerId, modelId: 'one' });
		expect(findEnabledModelByModelId(db, 'one')!.id).toBe(m.id);

		const otherProvider = createProvider(db, { name: 'A-first', type: 'openai-compatible' });
		const other = createModel(db, { providerId: otherProvider.id, modelId: 'one' });
		expect(findEnabledModelByModelId(db, 'one')!.id).toBe(other.id);

		db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(other.id);
		expect(findEnabledModelByModelId(db, 'one')!.id).toBe(m.id);

		db.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(providerId);
		expect(findEnabledModelByModelId(db, 'one')).toBeUndefined();
	});
});
