import { z } from 'zod';
import { getDb } from '$lib/server/db/index.js';
import {
	countPendingOAuthClients,
	purgeExpiredOAuth,
	registerOAuthClient
} from '$lib/server/db/repo/oauth.js';
import { isAllowedRedirectUri } from '$lib/server/oauth-server/index.js';
import { oauthError, oauthJson, preflight } from '$lib/server/oauth-server/http.js';
import type { RequestHandler } from './$types';

const bodySchema = z.object({
	redirect_uris: z.array(z.string().max(512)).min(1).max(5),
	client_name: z.string().trim().max(100).optional(),
	client_uri: z.string().max(512).optional()
});

/** Registrations nobody approved yet, across all callers; more are refused until some expire. */
const MAX_PENDING_CLIENTS = 200;
/** Per caller address, so one script can't use up the pending pool. */
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

function allow(address: string, now = Date.now()): boolean {
	if (buckets.size > 10_000) {
		for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
	}
	let bucket = buckets.get(address);
	if (!bucket || bucket.resetAt <= now) {
		bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
		buckets.set(address, bucket);
	}
	return ++bucket.count <= RATE_LIMIT;
}

// Dynamic client registration (RFC 7591). Every client is public: it proves
// itself with PKCE, so no secret is issued whatever it asks for.
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	if (!allow(getClientAddress())) {
		return oauthError('too_many_requests', 'Too many registrations, try again later', 429);
	}
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return oauthError('invalid_client_metadata', parsed.error.issues[0]?.message ?? 'Invalid body');
	}
	const bad = parsed.data.redirect_uris.find((uri) => !isAllowedRedirectUri(uri));
	if (bad) {
		return oauthError(
			'invalid_redirect_uri',
			'Redirect URIs must use https, http on localhost, or an app scheme'
		);
	}
	const db = getDb();
	if (countPendingOAuthClients(db) >= MAX_PENDING_CLIENTS) {
		purgeExpiredOAuth(db);
		if (countPendingOAuthClients(db) >= MAX_PENDING_CLIENTS) {
			return oauthError(
				'too_many_requests',
				'Too many pending registrations, try again later',
				429
			);
		}
	}
	const client = registerOAuthClient(db, {
		name: parsed.data.client_name || 'MCP client',
		redirectUris: parsed.data.redirect_uris,
		clientUri: parsed.data.client_uri ?? null
	});
	return oauthJson(
		{
			client_id: client.id,
			client_id_issued_at: Math.floor(client.created_at / 1000),
			client_name: client.name,
			redirect_uris: parsed.data.redirect_uris,
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none'
		},
		201
	);
};

export const OPTIONS: RequestHandler = () => preflight();
