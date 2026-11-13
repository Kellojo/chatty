import { resolveApiKeyIdentity, type ApiKeyIdentity } from '$lib/server/auth/apiKey.js';
import { getDb } from '$lib/server/db/index.js';
import { isOAuthAccessToken } from '$lib/server/db/repo/oauth.js';
import { handleMcpGatewayRequest, MCP_GATEWAY_SCOPE } from '$lib/server/mcp/gateway.js';
import {
	identityFromAccessToken,
	protectedResourceMetadataUrl
} from '$lib/server/oauth-server/index.js';
import { CORS_HEADERS, preflight } from '$lib/server/oauth-server/http.js';
import type { RequestHandler } from './$types';

/** A JSON-RPC error with no request id, as MCP clients expect from the transport. */
function rpcError(status: number, message: string, headers: Record<string, string> = {}) {
	return new Response(
		JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }),
		{ status, headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...headers } }
	);
}

/** An API key (`aic_…`) or an OAuth access token from the gateway's own sign-in. */
async function identify(authorization: string | null): Promise<ApiKeyIdentity | null> {
	const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
	if (isOAuthAccessToken(token)) return identityFromAccessToken(getDb(), token);
	return resolveApiKeyIdentity(getDb(), authorization);
}

// The MCP gateway (see $lib/server/mcp/gateway.ts). Stateless Streamable HTTP:
// only POST is served; there is no session to stream from (GET) or end (DELETE).
export const POST: RequestHandler = async ({ request, url }) => {
	const identity = await identify(request.headers.get('authorization'));
	if (!identity) {
		// Points OAuth-capable clients (Claude Code, Claude.ai…) at the sign-in (RFC 9728).
		return rpcError(401, 'Sign in or pass an API key', {
			'www-authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl(url.origin)}"`
		});
	}
	if (!identity.scopes.includes(MCP_GATEWAY_SCOPE)) {
		return rpcError(403, `API key is missing the '${MCP_GATEWAY_SCOPE}' scope`, {
			'www-authenticate': `Bearer error="insufficient_scope", scope="${MCP_GATEWAY_SCOPE}"`
		});
	}
	const response = await handleMcpGatewayRequest(request, identity);
	for (const [name, value] of Object.entries(CORS_HEADERS)) response.headers.set(name, value);
	return response;
};

const notAllowed: RequestHandler = () =>
	rpcError(405, 'Method not allowed: this MCP server is stateless', { allow: 'POST' });

export const GET = notAllowed;
export const DELETE = notAllowed;
export const OPTIONS: RequestHandler = () => preflight();
