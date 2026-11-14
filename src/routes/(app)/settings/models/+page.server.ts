import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	listModels,
	listRoleDefaults,
	toPublic as modelToPublic
} from '$lib/server/db/repo/models.js';
import { listProviders, toPublic as providerToPublic } from '$lib/server/db/repo/providers.js';
import { listAaModels } from '$lib/server/db/repo/aa-models.js';
import { getKeyInfo, getStatus } from '$lib/server/benchmarks/artificial-analysis.js';
import { matchScores } from '$lib/server/benchmarks/match.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	requireAdmin(locals);
	const db = getDb();
	const models = listModels(db).map(modelToPublic);
	const key = getKeyInfo(db);
	// Read-only: scores are fetched on model sync, by the Refresh button or when a key is saved.
	return {
		providers: listProviders(db).map(providerToPublic),
		models,
		/** Which model serves each purpose in Defaults. */
		roleDefaults: listRoleDefaults(db),
		/** Artificial Analysis Intelligence Index, by model row id. */
		scores: key.source ? matchScores(models, listAaModels(db)) : {},
		aa: { key, status: getStatus(db) }
	};
};
