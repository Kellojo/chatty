/**
 * Test fixtures for private-data specs: a user, a trusted and an untrusted
 * provider (each with one model), and helpers to mark things private. Only
 * imported by specs.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { createModel, setRoleDefault, type ModelRole } from '../db/repo/models.js';

/** The string every private fixture contains; it must never reach an untrusted provider. */
export const CANARY = 'CANARY-7f3a91-PRIVATE';

export interface PrivacyFixture {
	userId: string;
	trusted: { providerId: string; modelId: string; rowId: string };
	untrusted: { providerId: string; modelId: string; rowId: string };
}

function insertProvider(db: Db, name: string, baseUrl: string, trusted: boolean): string {
	const id = randomUUID();
	db.prepare(
		`INSERT INTO providers (id, name, type, base_url, api_key_enc, enabled, created_at, allow_private)
		 VALUES (?, ?, 'openai-compatible', ?, NULL, 1, ?, ?)`
	).run(id, name, baseUrl, Date.now(), trusted ? 1 : 0);
	return id;
}

/**
 * Seeds the user and both providers. `baseUrl(kind)` lets the canary test point
 * them at its recording server; capabilities cover every role.
 */
export function seedPrivacyFixture(
	db: Db,
	baseUrl: (kind: 'trusted' | 'untrusted') => string = (k) => `http://127.0.0.1:9/${k}/v1`,
	userId = 'u1'
): PrivacyFixture {
	db.prepare(
		`INSERT OR IGNORE INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
		 VALUES (?, ?, 'U', 0, 0, 0, 'admin')`
	).run(userId, `${userId}@example.com`);
	const capabilities = ['chat', 'streaming', 'image', 'transcription', 'speech', 'decisions'];
	const make = (kind: 'trusted' | 'untrusted') => {
		const providerId = insertProvider(db, `${kind} provider`, baseUrl(kind), kind === 'trusted');
		const modelId = `${kind}-model`;
		const row = createModel(db, { providerId, modelId, capabilities });
		return { providerId, modelId, rowId: row.id };
	};
	return { userId, trusted: make('trusted'), untrusted: make('untrusted') };
}

/** Points a role at a fixture model. */
export function setRole(db: Db, role: ModelRole, model: { rowId: string }): void {
	setRoleDefault(db, role, model.rowId);
}

/** A mapping over `targets`, as a model ref (`mapping:<id>`). */
export function createMapping(
	db: Db,
	name: string,
	targets: { providerId: string; modelId: string }[]
): { providerId: string; modelId: string; id: string } {
	const id = randomUUID();
	db.prepare(
		'INSERT INTO model_mappings (id, name, targets, enabled, created_at) VALUES (?, ?, ?, 1, ?)'
	).run(id, name, JSON.stringify(targets), Date.now());
	return { providerId: `mapping:${id}`, modelId: name, id };
}

export function markConversationPrivate(db: Db, conversationId: string, value = true): void {
	db.prepare('UPDATE conversations SET private = ? WHERE id = ?').run(
		value ? 1 : 0,
		conversationId
	);
}
