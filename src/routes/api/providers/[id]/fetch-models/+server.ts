import { json, error } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getProvider } from '$lib/server/db/repo/providers.js';
import { upsertFetchedModels, type FetchedModel } from '$lib/server/db/repo/models.js';
import { fetchProviderModels } from '$lib/server/llm/registry.js';
import { refreshScores } from '$lib/server/benchmarks/artificial-analysis.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, params }) => {
	requireAdmin(locals);
	const db = getDb();
	if (!getProvider(db, params.id)) error(404, { message: 'Provider not found' });
	let fetched: FetchedModel[];
	try {
		fetched = await fetchProviderModels(params.id);
	} catch (e) {
		error(502, { message: e instanceof Error ? e.message : 'Failed to fetch models' });
	}
	const result = upsertFetchedModels(db, params.id, fetched);
	// The model list just changed: refresh Intelligence Index scores as part of the sync
	// (at most hourly; a failure is recorded in its status and never fails the sync).
	await refreshScores(db, 'sync');
	return json(result);
};
