import { randomUUID } from 'node:crypto';
import type { ModelMapping, ModelMappingTarget } from '$lib/types.js';
import type { Db } from '../index.js';

export interface ModelMappingRow {
	id: string;
	name: string;
	targets: string;
	enabled: number;
	/** 1: may only route to providers trusted with private data. */
	trusted_only: number;
	created_at: number;
}

export function toPublic(row: ModelMappingRow): ModelMapping {
	return {
		id: row.id,
		name: row.name,
		targets: JSON.parse(row.targets) as ModelMappingTarget[],
		enabled: row.enabled === 1,
		trustedOnly: row.trusted_only === 1,
		createdAt: row.created_at
	};
}

export function parseTargets(row: ModelMappingRow): ModelMappingTarget[] {
	return JSON.parse(row.targets) as ModelMappingTarget[];
}

export interface CreateModelMappingInput {
	name: string;
	targets: ModelMappingTarget[];
	enabled?: boolean;
	trustedOnly?: boolean;
}

export function createModelMapping(db: Db, input: CreateModelMappingInput): ModelMappingRow {
	const id = randomUUID();
	db.prepare(
		'INSERT INTO model_mappings (id, name, targets, enabled, trusted_only, created_at) VALUES (?, ?, ?, ?, ?, ?)'
	).run(
		id,
		input.name,
		JSON.stringify(input.targets),
		input.enabled === false ? 0 : 1,
		input.trustedOnly === true ? 1 : 0,
		Date.now()
	);
	return getModelMapping(db, id)!;
}

export interface UpdateModelMappingInput {
	name?: string;
	targets?: ModelMappingTarget[];
	enabled?: boolean;
	trustedOnly?: boolean;
}

export function updateModelMapping(
	db: Db,
	id: string,
	patch: UpdateModelMappingInput
): ModelMappingRow | undefined {
	const existing = getModelMapping(db, id);
	if (!existing) return undefined;
	db.prepare(
		'UPDATE model_mappings SET name = ?, targets = ?, enabled = ?, trusted_only = ? WHERE id = ?'
	).run(
		patch.name ?? existing.name,
		patch.targets !== undefined ? JSON.stringify(patch.targets) : existing.targets,
		patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
		patch.trustedOnly !== undefined ? (patch.trustedOnly ? 1 : 0) : existing.trusted_only,
		id
	);
	return getModelMapping(db, id);
}

export function deleteModelMapping(db: Db, id: string): boolean {
	return db.prepare('DELETE FROM model_mappings WHERE id = ?').run(id).changes > 0;
}

export function getModelMapping(db: Db, id: string): ModelMappingRow | undefined {
	return db.prepare('SELECT * FROM model_mappings WHERE id = ?').get(id) as
		ModelMappingRow | undefined;
}

export function getModelMappingByName(db: Db, name: string): ModelMappingRow | undefined {
	return db.prepare('SELECT * FROM model_mappings WHERE name = ?').get(name) as
		ModelMappingRow | undefined;
}

export function listModelMappings(db: Db): ModelMappingRow[] {
	return db.prepare('SELECT * FROM model_mappings ORDER BY name').all() as ModelMappingRow[];
}

export function listEnabledModelMappings(db: Db): ModelMappingRow[] {
	return db
		.prepare('SELECT * FROM model_mappings WHERE enabled = 1 ORDER BY name')
		.all() as ModelMappingRow[];
}
