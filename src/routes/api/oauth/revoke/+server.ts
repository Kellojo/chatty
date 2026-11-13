import { getDb } from '$lib/server/db/index.js';
import { revokeToken } from '$lib/server/db/repo/oauth.js';
import { oauthError, preflight, readParams, CORS_HEADERS } from '$lib/server/oauth-server/http.js';
import type { RequestHandler } from './$types';

// Token revocation (RFC 7009): a client signing out. Unknown tokens still get 200.
// Exempt from the CSRF check like the token endpoint (see hooks.server.ts).
export const POST: RequestHandler = async ({ request }) => {
	const params = await readParams(request);
	const token = params.get('token');
	const clientId = params.get('client_id');
	if (!token || !clientId) return oauthError('invalid_request', 'token and client_id are required');
	revokeToken(getDb(), token, clientId);
	return new Response(null, { status: 200, headers: CORS_HEADERS });
};

export const OPTIONS: RequestHandler = () => preflight();
