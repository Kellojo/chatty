import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { ApiKey } from '$lib/types.js';
import type { Db } from '../index.js';

export interface ApiKeyRow {
	id: string;
	user_id: string;
	label: string;
	hash: string;
	scopes: string;
	created_at: number;
	last_used_at: number | null;
}

export function toPublic(row: ApiKeyRow): ApiKey {
	return {
		id: row.id,
		label: row.label,
		scopes: JSON.parse(row.scopes) as string[],
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at
	};
}

export interface CreateApiKeyInput {
	userId: string;
	label: string;
	scopes?: string[];
}

export async function createApiKey(
	db: Db,
	input: CreateApiKeyInput
): Promise<{ row: ApiKeyRow; rawKey: string }> {
	const id = randomUUID();
	const rawKey = `aic_${id}_${randomBytes(24).toString('base64url')}`;
	const keyHash = await hash(rawKey);
	db.prepare(
		'INSERT INTO api_keys (id, user_id, label, hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
	).run(
		id,
		input.userId,
		input.label,
		keyHash,
		JSON.stringify(input.scopes ?? ['agents:run']),
		Date.now()
	);
	return { row: getApiKey(db, id)!, rawKey };
}

export function getApiKey(db: Db, id: string): ApiKeyRow | undefined {
	return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow | undefined;
}

export function listApiKeys(db: Db, userId: string): ApiKeyRow[] {
	return db
		.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC')
		.all(userId) as ApiKeyRow[];
}

// argon2 is deliberately slow, so successful verifications are cached
// briefly. Keyed by a SHA-256 of the presented key (the plaintext is never
// stored) and only honoured while the row still exists with the same hash.
const VERIFY_CACHE_TTL_MS = 60_000;
const VERIFY_CACHE_MAX = 500;
const verifyCache = new Map<string, { keyId: string; hash: string; expiresAt: number }>();

function digest(rawKey: string): string {
	return createHash('sha256').update(rawKey).digest('hex');
}

function forgetKey(keyId: string): void {
	for (const [k, v] of verifyCache) if (v.keyId === keyId) verifyCache.delete(k);
}

export function deleteApiKey(db: Db, id: string, userId: string): boolean {
	const deleted =
		db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
	if (deleted) forgetKey(id);
	return deleted;
}

export async function resolveApiKey(db: Db, rawKey: string): Promise<ApiKeyRow | null> {
	if (!rawKey.startsWith('aic_')) return null;
	const rest = rawKey.slice(4);
	const sep = rest.indexOf('_');
	if (sep <= 0 || sep === rest.length - 1) return null;
	const row = getApiKey(db, rest.slice(0, sep));
	if (!row) return null;
	const cacheKey = digest(rawKey);
	const cached = verifyCache.get(cacheKey);
	const now = Date.now();
	if (!cached || cached.keyId !== row.id || cached.hash !== row.hash || cached.expiresAt <= now) {
		if (cached) verifyCache.delete(cacheKey);
		try {
			if (!(await verify(row.hash, rawKey))) return null;
		} catch {
			return null;
		}
		if (verifyCache.size >= VERIFY_CACHE_MAX) {
			verifyCache.delete(verifyCache.keys().next().value!);
		}
		verifyCache.set(cacheKey, {
			keyId: row.id,
			hash: row.hash,
			expiresAt: now + VERIFY_CACHE_TTL_MS
		});
	}
	db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
	return getApiKey(db, row.id)!;
}
