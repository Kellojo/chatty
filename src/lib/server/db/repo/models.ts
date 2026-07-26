import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';

export const MODEL_ROLES = ['chat', 'title', 'memory', 'image'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export interface ModelRow {
	id: string;
	provider_id: string;
	model_id: string;
	display_name: string;
	capabilities: string;
	enabled: number;
	price_input: number | null;
	price_output: number | null;
}

export interface ChatModel {
	id: string;
	providerId: string;
	modelId: string;
	displayName: string;
	capabilities: string[];
	enabled: boolean;
	priceInput: number | null;
	priceOutput: number | null;
}

export function toPublic(row: ModelRow): ChatModel {
	return {
		id: row.id,
		providerId: row.provider_id,
		modelId: row.model_id,
		displayName: row.display_name,
		capabilities: JSON.parse(row.capabilities) as string[],
		enabled: row.enabled === 1,
		priceInput: row.price_input,
		priceOutput: row.price_output
	};
}

export function listModels(db: Db, providerId?: string): ModelRow[] {
	if (providerId) {
		return db
			.prepare('SELECT * FROM models WHERE provider_id = ? ORDER BY model_id')
			.all(providerId) as ModelRow[];
	}
	return db.prepare('SELECT * FROM models ORDER BY provider_id, model_id').all() as ModelRow[];
}

export function listEnabledModels(db: Db): ModelRow[] {
	return db
		.prepare(
			`SELECT m.* FROM models m
			 JOIN providers p ON p.id = m.provider_id
			 WHERE m.enabled = 1 AND p.enabled = 1
			 ORDER BY p.name, m.model_id`
		)
		.all() as ModelRow[];
}

export function findEnabledModelByModelId(db: Db, modelId: string): ModelRow | undefined {
	return db
		.prepare(
			`SELECT m.* FROM models m
			 JOIN providers p ON p.id = m.provider_id
			 WHERE m.model_id = ? AND m.enabled = 1 AND p.enabled = 1
			 ORDER BY p.name LIMIT 1`
		)
		.get(modelId) as ModelRow | undefined;
}

export function getModel(db: Db, id: string): ModelRow | undefined {
	return db.prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow | undefined;
}

export function findModel(db: Db, providerId: string, modelId: string): ModelRow | undefined {
	return db
		.prepare('SELECT * FROM models WHERE provider_id = ? AND model_id = ?')
		.get(providerId, modelId) as ModelRow | undefined;
}

export interface CreateModelInput {
	providerId: string;
	modelId: string;
	displayName?: string;
	capabilities?: string[];
	enabled?: boolean;
}

export function createModel(db: Db, input: CreateModelInput): ModelRow {
	const id = randomUUID();
	db.prepare(
		'INSERT INTO models (id, provider_id, model_id, display_name, capabilities, enabled) VALUES (?, ?, ?, ?, ?, ?)'
	).run(
		id,
		input.providerId,
		input.modelId,
		input.displayName ?? input.modelId,
		JSON.stringify(input.capabilities ?? ['chat', 'streaming']),
		input.enabled === false ? 0 : 1
	);
	return getModel(db, id)!;
}

export interface UpdateModelInput {
	displayName?: string;
	capabilities?: string[];
	enabled?: boolean;
	priceInput?: number | null;
	priceOutput?: number | null;
}

export function updateModel(db: Db, id: string, patch: UpdateModelInput): ModelRow | undefined {
	const existing = getModel(db, id);
	if (!existing) return undefined;
	db.prepare(
		`UPDATE models SET display_name = ?, capabilities = ?, enabled = ?, price_input = ?, price_output = ?
		 WHERE id = ?`
	).run(
		patch.displayName ?? existing.display_name,
		patch.capabilities !== undefined ? JSON.stringify(patch.capabilities) : existing.capabilities,
		patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
		patch.priceInput !== undefined ? patch.priceInput : existing.price_input,
		patch.priceOutput !== undefined ? patch.priceOutput : existing.price_output,
		id
	);
	return getModel(db, id);
}

export function deleteModel(db: Db, id: string): boolean {
	return db.prepare('DELETE FROM models WHERE id = ?').run(id).changes > 0;
}

export function listRoleDefaults(db: Db): Partial<Record<ModelRole, string>> {
	const rows = db.prepare('SELECT role, model_id FROM role_defaults').all() as {
		role: ModelRole;
		model_id: string;
	}[];
	return Object.fromEntries(rows.map((r) => [r.role, r.model_id]));
}

export function setRoleDefault(db: Db, role: ModelRole, modelId: string | null): void {
	if (modelId === null) {
		db.prepare('DELETE FROM role_defaults WHERE role = ?').run(role);
		return;
	}
	db.prepare(
		'INSERT INTO role_defaults (role, model_id) VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET model_id = excluded.model_id'
	).run(role, modelId);
}

export function findRoleModel(db: Db, role: ModelRole): ModelRow | undefined {
	const stored = db.prepare('SELECT model_id FROM role_defaults WHERE role = ?').get(role) as
		{ model_id: string } | undefined;
	if (!stored) return undefined;
	if (stored.model_id.startsWith('mapping:')) {
		const mapping = db
			.prepare('SELECT * FROM model_mappings WHERE id = ? AND enabled = 1')
			.get(stored.model_id.slice('mapping:'.length)) as { id: string; name: string } | undefined;
		if (!mapping) return undefined;
		return {
			id: `mapping:${mapping.id}`,
			provider_id: `mapping:${mapping.id}`,
			model_id: mapping.name,
			display_name: mapping.name,
			capabilities: '[]',
			enabled: 1,
			price_input: null,
			price_output: null
		};
	}
	return db
		.prepare(
			`SELECT m.* FROM role_defaults r
			 JOIN models m ON m.id = r.model_id
			 JOIN providers p ON p.id = m.provider_id
			 WHERE r.role = ? AND m.enabled = 1 AND p.enabled = 1`
		)
		.get(role) as ModelRow | undefined;
}

export interface FetchedModel {
	id: string;
	capabilities?: string[];
	priceInput?: number | null;
	priceOutput?: number | null;
}

export function upsertFetchedModels(
	db: Db,
	providerId: string,
	fetched: FetchedModel[]
): { added: number; total: number } {
	let added = 0;
	db.transaction(() => {
		for (const model of fetched) {
			const existing = findModel(db, providerId, model.id);
			if (!existing) {
				const created = createModel(db, {
					providerId,
					modelId: model.id,
					capabilities: model.capabilities
				});
				if (model.priceInput != null || model.priceOutput != null) {
					updateModel(db, created.id, {
						priceInput: model.priceInput ?? null,
						priceOutput: model.priceOutput ?? null
					});
				}
				added++;
			} else if (model.priceInput != null || model.priceOutput != null) {
				updateModel(db, existing.id, {
					priceInput: model.priceInput ?? existing.price_input,
					priceOutput: model.priceOutput ?? existing.price_output
				});
			}
		}
	})();
	return { added, total: fetched.length };
}
