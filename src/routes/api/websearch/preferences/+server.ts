import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	configuredProviders,
	getWebSearchInfo,
	PROVIDER_IDS,
	SEARCH_MODES,
	setSearchPreferences
} from '$lib/server/websearch/service.js';
import type { RequestHandler } from './$types';

const bodySchema = z
	.object({
		defaultProvider: z.enum(PROVIDER_IDS),
		mode: z.enum(SEARCH_MODES),
		/** Unknown ids are dropped when saved; unconfigured ones are kept. */
		backupOnly: z.array(z.string().max(50)).max(20)
	})
	.partial()
	.strict();

/**
 * Updates how web search uses the providers: the search mode, the Fallback default and
 * which providers are Backup only. The whole body is checked first, then saved at once.
 */
export const PUT: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const db = getDb();
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Invalid search preferences' });
	const prefs = parsed.data;
	if (prefs.defaultProvider && !configuredProviders(db).includes(prefs.defaultProvider)) {
		error(400, { message: 'Configure that provider first' });
	}
	setSearchPreferences(db, prefs);
	return json(getWebSearchInfo(db));
};
