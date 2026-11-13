// Storage for the MCP gateway's OAuth server (see src/lib/server/oauth-server/).
// Codes and tokens are random 256-bit values, so a plain SHA-256 is enough to
// store them; the raw values only ever exist in responses.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../index.js';
import { getApiKey, type ApiKeyRow } from './api-keys.js';

export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60_000;
export const CODE_TTL_MS = 5 * 60_000;
/** Registered clients that never got a key are dropped after this long. */
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60_000;

const ACCESS_PREFIX = 'mcpat_';
const REFRESH_PREFIX = 'mcprt_';

export interface OAuthClientRow {
	id: string;
	name: string;
	redirect_uris: string;
	client_uri: string | null;
	created_at: number;
	approved_at: number | null;
}

export function hashSecret(raw: string): string {
	return createHash('sha256').update(raw).digest('hex');
}

function secret(prefix = ''): string {
	return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export function isOAuthAccessToken(raw: string): boolean {
	return raw.startsWith(ACCESS_PREFIX);
}

export function redirectUris(client: OAuthClientRow): string[] {
	try {
		const parsed: unknown = JSON.parse(client.redirect_uris);
		return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
	} catch {
		return [];
	}
}

export function registerOAuthClient(
	db: Db,
	input: { name: string; redirectUris: string[]; clientUri?: string | null }
): OAuthClientRow {
	const id = randomUUID();
	db.prepare(
		'INSERT INTO oauth_clients (id, name, redirect_uris, client_uri, created_at) VALUES (?, ?, ?, ?, ?)'
	).run(id, input.name, JSON.stringify(input.redirectUris), input.clientUri ?? null, Date.now());
	return getOAuthClient(db, id)!;
}

/** Registrations nobody has approved yet (the register endpoint caps these). */
export function countPendingOAuthClients(db: Db): number {
	return (
		db.prepare('SELECT COUNT(*) AS n FROM oauth_clients WHERE approved_at IS NULL').get() as {
			n: number;
		}
	).n;
}

export function getOAuthClient(db: Db, id: string): OAuthClientRow | undefined {
	return db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(id) as
		OAuthClientRow | undefined;
}

/** The user's key for this client, if they approved it before. */
export function findOAuthKey(db: Db, userId: string, clientId: string): ApiKeyRow | undefined {
	return db
		.prepare(
			'SELECT * FROM api_keys WHERE user_id = ? AND oauth_client_id = ? ORDER BY created_at DESC LIMIT 1'
		)
		.get(userId, clientId) as ApiKeyRow | undefined;
}

/** Remembers that a user approved the client, so its registration is kept. */
export function markOAuthClientApproved(db: Db, clientId: string): void {
	db.prepare('UPDATE oauth_clients SET approved_at = ? WHERE id = ? AND approved_at IS NULL').run(
		Date.now(),
		clientId
	);
}

export function createAuthorizationCode(
	db: Db,
	input: { clientId: string; apiKeyId: string; redirectUri: string; codeChallenge: string }
): string {
	const code = secret();
	db.prepare(
		`INSERT INTO oauth_codes (code_hash, client_id, api_key_id, redirect_uri, code_challenge, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(
		hashSecret(code),
		input.clientId,
		input.apiKeyId,
		input.redirectUri,
		input.codeChallenge,
		Date.now() + CODE_TTL_MS
	);
	return code;
}

export interface AuthorizationCodeRow {
	client_id: string;
	api_key_id: string;
	redirect_uri: string;
	code_challenge: string;
	expires_at: number;
}

/** Takes a code out of storage (codes are single-use), or undefined if unknown or expired. */
export function consumeAuthorizationCode(db: Db, code: string): AuthorizationCodeRow | undefined {
	const row = db
		.prepare(
			`DELETE FROM oauth_codes WHERE code_hash = ?
			 RETURNING client_id, api_key_id, redirect_uri, code_challenge, expires_at`
		)
		.get(hashSecret(code)) as AuthorizationCodeRow | undefined;
	return row && row.expires_at > Date.now() ? row : undefined;
}

export interface IssuedTokens {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
}

export function issueTokens(db: Db, apiKeyId: string, clientId: string): IssuedTokens {
	const now = Date.now();
	const accessToken = secret(ACCESS_PREFIX);
	const refreshToken = secret(REFRESH_PREFIX);
	const insert = db.prepare(
		`INSERT INTO oauth_tokens (token_hash, kind, api_key_id, client_id, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	);
	db.transaction(() => {
		insert.run(
			hashSecret(accessToken),
			'access',
			apiKeyId,
			clientId,
			now + ACCESS_TOKEN_TTL_MS,
			now
		);
		insert.run(
			hashSecret(refreshToken),
			'refresh',
			apiKeyId,
			clientId,
			now + REFRESH_TOKEN_TTL_MS,
			now
		);
	})();
	return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_MS / 1000 };
}

/**
 * Swaps a refresh token for a new pair; the old one is kept, marked used. A
 * token that was already used means it leaked (the thief or the real client got
 * there first), so every token of that key and client is revoked and the client
 * has to sign in again. Undefined when the token is unknown, expired, used, or
 * belongs to another client.
 */
export function rotateRefreshToken(
	db: Db,
	refreshToken: string,
	clientId: string
): IssuedTokens | undefined {
	return db.transaction(() => {
		const hash = hashSecret(refreshToken);
		const row = db
			.prepare(
				`SELECT api_key_id, client_id, expires_at, used_at FROM oauth_tokens
				 WHERE token_hash = ? AND kind = 'refresh'`
			)
			.get(hash) as
			| { api_key_id: string; client_id: string; expires_at: number; used_at: number | null }
			| undefined;
		if (!row || row.client_id !== clientId) return undefined;
		if (row.used_at !== null) {
			revokeClientTokens(db, row.api_key_id, clientId);
			return undefined;
		}
		if (row.expires_at <= Date.now()) return undefined;
		db.prepare('UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ?').run(Date.now(), hash);
		return issueTokens(db, row.api_key_id, clientId);
	})();
}

/** Signs a client out of a key: drops all its codes and tokens for it. */
export function revokeClientTokens(db: Db, apiKeyId: string, clientId: string): void {
	db.prepare('DELETE FROM oauth_tokens WHERE api_key_id = ? AND client_id = ?').run(
		apiKeyId,
		clientId
	);
	db.prepare('DELETE FROM oauth_codes WHERE api_key_id = ? AND client_id = ?').run(
		apiKeyId,
		clientId
	);
}

/** The key behind a live access token. */
export function resolveAccessToken(db: Db, accessToken: string): ApiKeyRow | undefined {
	const row = db
		.prepare(
			`SELECT api_key_id FROM oauth_tokens
			 WHERE token_hash = ? AND kind = 'access' AND expires_at > ?`
		)
		.get(hashSecret(accessToken), Date.now()) as { api_key_id: string } | undefined;
	if (!row) return undefined;
	db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.api_key_id);
	return getApiKey(db, row.api_key_id);
}

/** Revokes one token (RFC 7009): unknown tokens are not an error. */
export function revokeToken(db: Db, token: string, clientId: string): void {
	db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ? AND client_id = ?').run(
		hashSecret(token),
		clientId
	);
}

/** Drops expired codes and tokens, and registrations nobody ever approved. */
export function purgeExpiredOAuth(db: Db, now = Date.now()): void {
	db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(now);
	db.prepare('DELETE FROM oauth_tokens WHERE expires_at <= ?').run(now);
	db.prepare('DELETE FROM oauth_clients WHERE approved_at IS NULL AND created_at <= ?').run(
		now - UNUSED_CLIENT_TTL_MS
	);
}
