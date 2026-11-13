import { authorizationServerMetadata } from '$lib/server/oauth-server/index.js';
import { oauthJson, preflight } from '$lib/server/oauth-server/http.js';
import type { RequestHandler } from './$types';

// RFC 8414: the endpoints of the OAuth server that signs MCP clients in.
export const GET: RequestHandler = ({ url }) => oauthJson(authorizationServerMetadata(url.origin));
export const OPTIONS: RequestHandler = () => preflight();
