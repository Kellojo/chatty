import { json, error, isHttpError } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb, type Db } from '$lib/server/db/index.js';
import {
	clearApiKey,
	clearSearxngUrl,
	getWebSearchInfo,
	isKeyProvider,
	KEY_PROVIDERS,
	saveApiKey,
	saveSearxngUrl,
	type KeyProviderId
} from '$lib/server/websearch/service.js';
import type { RequestHandler } from './$types';

const urlSchema = z.object({ url: z.string().trim().min(1).max(2000) });
const keySchema = z.object({ apiKey: z.string().trim().min(1).max(500) });

/** The provider from the path, refused when its env var pins the setting. */
function resolve(
	param: string,
	action: 'change' | 'remove'
): { db: Db; provider: 'searxng' | KeyProviderId } {
	const db = getDb();
	if (param !== 'searxng' && !isKeyProvider(param)) error(404, { message: 'Unknown provider' });
	const provider = param as 'searxng' | KeyProviderId;
	const envVar = provider === 'searxng' ? 'SEARXNG_URL' : KEY_PROVIDERS[provider].envVar;
	if (getWebSearchInfo(db)[provider].source === 'env') {
		const what = provider === 'searxng' ? 'URL' : 'key';
		error(409, { message: `The ${what} is set by ${envVar}; ${action} it there.` });
	}
	return { db, provider };
}

/**
 * Saves SearXNG's URL (`{ url }`) or a provider's API key (`{ apiKey }`, stored encrypted),
 * only after a test search with it succeeds.
 */
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	requireAdmin(locals);
	const { db, provider } = resolve(params.provider, 'change');
	const body = await request.json().catch(() => null);
	try {
		if (provider === 'searxng') {
			const parsed = urlSchema.safeParse(body);
			if (!parsed.success) error(400, { message: 'Enter the SearXNG URL' });
			await saveSearxngUrl(db, parsed.data.url);
		} else {
			const parsed = keySchema.safeParse(body);
			if (!parsed.success) error(400, { message: 'Enter an API key' });
			await saveApiKey(db, provider, parsed.data.apiKey);
		}
	} catch (e) {
		if (isHttpError(e)) throw e;
		error(400, { message: e instanceof Error ? e.message : 'Could not verify the provider' });
	}
	return json(getWebSearchInfo(db));
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireAdmin(locals);
	const { db, provider } = resolve(params.provider, 'remove');
	if (provider === 'searxng') clearSearxngUrl(db);
	else clearApiKey(db, provider);
	return json(getWebSearchInfo(db));
};
