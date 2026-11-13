import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getModelCatalog } from '$lib/server/llm/model-catalog.js';
import type { RequestHandler } from './$types';

/**
 * The picker models. Asked for by version (`?v=`), the response for the current
 * version never changes, so the browser may keep it; any other request gets the
 * current list uncached.
 */
export const GET: RequestHandler = ({ locals, url }) => {
	requireUser(locals);
	const catalog = getModelCatalog();
	const current = url.searchParams.get('v') === catalog.version;
	return json(catalog, {
		headers: {
			'cache-control': current ? 'private, max-age=31536000, immutable' : 'private, no-cache'
		}
	});
};
