import { randomUUID } from 'node:crypto';
import { encryptSecret } from '../../crypto.js';
import type { Db } from '../index.js';

export type ProviderType = 'anthropic' | 'openai-compatible';

export interface ProviderRow {
	id: string;
	name: string;
	type: ProviderType;
	base_url: string | null;
	api_key_enc: string | null;
	enabled: number;
	/** 1: an admin trusts this provider with private data. */
	allow_private: number;
	created_at: number;
}

export interface Provider {
	id: string;
	name: string;
	type: ProviderType;
	baseUrl: string | null;
	hasApiKey: boolean;
	enabled: boolean;
	/** An admin trusts this provider with private data ("Can process private data"). */
	allowPrivate: boolean;
	createdAt: number;
}

export function toPublic(row: ProviderRow): Provider {
	return {
		id: row.id,
		name: row.name,
		type: row.type,
		baseUrl: row.base_url,
		hasApiKey: row.api_key_enc != null && row.api_key_enc.length > 0,
		enabled: row.enabled === 1,
		allowPrivate: row.allow_private === 1,
		createdAt: row.created_at
	};
}

export function listProviders(db: Db): ProviderRow[] {
	return db.prepare('SELECT * FROM providers ORDER BY created_at').all() as ProviderRow[];
}

export function getProvider(db: Db, id: string): ProviderRow | undefined {
	return db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined;
}

export interface CreateProviderInput {
	name: string;
	type: ProviderType;
	baseUrl?: string | null;
	apiKey?: string | null;
	enabled?: boolean;
	/** Fails closed: a provider is untrusted unless this is true. */
	allowPrivate?: boolean;
}

export function createProvider(db: Db, input: CreateProviderInput): ProviderRow {
	const id = randomUUID();
	db.prepare(
		'INSERT INTO providers (id, name, type, base_url, api_key_enc, enabled, allow_private, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
	).run(
		id,
		input.name,
		input.type,
		input.baseUrl ?? null,
		input.apiKey ? encryptSecret(input.apiKey) : null,
		input.enabled === false ? 0 : 1,
		input.allowPrivate === true ? 1 : 0,
		Date.now()
	);
	return getProvider(db, id)!;
}

export interface UpdateProviderInput {
	name?: string;
	type?: ProviderType;
	baseUrl?: string | null;
	apiKey?: string | null;
	enabled?: boolean;
	allowPrivate?: boolean;
}

export function updateProvider(
	db: Db,
	id: string,
	patch: UpdateProviderInput
): ProviderRow | undefined {
	const existing = getProvider(db, id);
	if (!existing) return undefined;
	db.prepare(
		'UPDATE providers SET name = ?, type = ?, base_url = ?, api_key_enc = ?, enabled = ?, allow_private = ? WHERE id = ?'
	).run(
		patch.name ?? existing.name,
		patch.type ?? existing.type,
		patch.baseUrl !== undefined ? patch.baseUrl : existing.base_url,
		patch.apiKey !== undefined
			? patch.apiKey
				? encryptSecret(patch.apiKey)
				: null
			: existing.api_key_enc,
		patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
		patch.allowPrivate !== undefined ? (patch.allowPrivate ? 1 : 0) : existing.allow_private,
		id
	);
	return getProvider(db, id);
}

export function deleteProvider(db: Db, id: string): boolean {
	return db.prepare('DELETE FROM providers WHERE id = ?').run(id).changes > 0;
}
