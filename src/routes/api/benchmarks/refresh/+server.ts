import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { refreshScores } from '$lib/server/benchmarks/artificial-analysis.js';
import type { RequestHandler } from './$types';

/** Manual "Refresh" from Settings → Models; still subject to the manual cooldown. */
export const POST: RequestHandler = async ({ locals }) => {
	requireAdmin(locals);
	return json(await refreshScores(getDb(), 'manual'));
};
