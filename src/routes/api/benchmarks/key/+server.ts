import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { clearApiKey, getKeyInfo, saveApiKey } from '$lib/server/benchmarks/artificial-analysis.js';
import type { RequestHandler } from './$types';

const bodySchema = z.object({ apiKey: z.string().trim().min(1).max(500) });

/** Saves the key only after a successful fetch with it, which also fills the score cache. */
export const PUT: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const db = getDb();
	if (getKeyInfo(db).source === 'env') {
		error(409, { message: 'The key is set by ARTIFICIAL_ANALYSIS_API_KEY; change it there.' });
	}
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Enter an API key' });
	try {
		const status = await saveApiKey(db, parsed.data.apiKey);
		return json({ key: getKeyInfo(db), status });
	} catch (e) {
		error(400, { message: e instanceof Error ? e.message : 'Could not verify the key' });
	}
};

/** Removes the key and the cached scores, which turns the feature off. */
export const DELETE: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	const db = getDb();
	if (getKeyInfo(db).source === 'env') {
		error(409, { message: 'The key is set by ARTIFICIAL_ANALYSIS_API_KEY; remove it there.' });
	}
	clearApiKey(db);
	return json({ ok: true });
};
