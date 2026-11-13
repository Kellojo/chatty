import { getDb } from '$lib/server/db/index.js';
import {
	consumeAuthorizationCode,
	getOAuthClient,
	issueTokens,
	rotateRefreshToken,
	type IssuedTokens
} from '$lib/server/db/repo/oauth.js';
import { isOurResource, OAUTH_SCOPE, verifyPkce } from '$lib/server/oauth-server/index.js';
import { oauthError, oauthJson, preflight, readParams } from '$lib/server/oauth-server/http.js';
import type { RequestHandler } from './$types';

function tokenResponse(tokens: IssuedTokens): Response {
	return oauthJson({
		access_token: tokens.accessToken,
		token_type: 'Bearer',
		expires_in: tokens.expiresIn,
		refresh_token: tokens.refreshToken,
		scope: OAUTH_SCOPE
	});
}

// The token endpoint (RFC 6749 §3.2): codes and refresh tokens for tokens.
// Called by other apps' servers, so it is exempt from the CSRF check (see hooks.server.ts).
export const POST: RequestHandler = async ({ request, url }) => {
	const params = await readParams(request);
	const db = getDb();
	const clientId = params.get('client_id');
	if (!clientId || !getOAuthClient(db, clientId)) {
		return oauthError('invalid_client', 'Unknown client', 401);
	}
	if (!isOurResource(params.get('resource'), url.origin)) {
		return oauthError('invalid_target', 'Unknown resource');
	}

	switch (params.get('grant_type')) {
		case 'authorization_code': {
			const code = params.get('code');
			const verifier = params.get('code_verifier');
			if (!code || !verifier)
				return oauthError('invalid_request', 'code and code_verifier are required');
			const grant = consumeAuthorizationCode(db, code);
			if (
				!grant ||
				grant.client_id !== clientId ||
				(params.get('redirect_uri') ?? grant.redirect_uri) !== grant.redirect_uri ||
				!verifyPkce(verifier, grant.code_challenge)
			) {
				return oauthError('invalid_grant', 'The code is invalid, expired or already used');
			}
			return tokenResponse(issueTokens(db, grant.api_key_id, clientId));
		}
		case 'refresh_token': {
			const refreshToken = params.get('refresh_token');
			if (!refreshToken) return oauthError('invalid_request', 'refresh_token is required');
			const tokens = rotateRefreshToken(db, refreshToken, clientId);
			if (!tokens) return oauthError('invalid_grant', 'The refresh token is invalid or expired');
			return tokenResponse(tokens);
		}
		default:
			return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
	}
};

export const OPTIONS: RequestHandler = () => preflight();
