import { json } from '@sveltejs/kit';
import { appOrigin, clientMetadataDocument } from '$lib/server/mcp/oauth.js';
import type { RequestHandler } from './$types';

/**
 * Chatty's OAuth Client ID Metadata Document. Its URL is Chatty's client ID at
 * authorization servers that support these documents, which fetch it to learn
 * Chatty's name and redirect URL. Public by design: it holds no secrets.
 */
export const GET: RequestHandler = ({ url }) =>
	json(clientMetadataDocument(appOrigin(url.origin)), {
		headers: { 'cache-control': 'public, max-age=3600' }
	});
