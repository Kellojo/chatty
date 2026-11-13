import { protectedResourceMetadata } from '$lib/server/oauth-server/index.js';
import { oauthJson, preflight } from '$lib/server/oauth-server/http.js';
import type { RequestHandler } from './$types';

// RFC 9728: tells MCP clients which authorization server guards /api/mcp. Served
// both at the root and at the resource's path (/.well-known/…/api/mcp).
export const GET: RequestHandler = ({ url }) => oauthJson(protectedResourceMetadata(url.origin));
export const OPTIONS: RequestHandler = () => preflight();
