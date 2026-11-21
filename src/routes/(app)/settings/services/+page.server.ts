import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { listAaModels } from '$lib/server/db/repo/aa-models.js';
import { listModels, toPublic as modelToPublic } from '$lib/server/db/repo/models.js';
import { getKeyInfo, getStatus } from '$lib/server/benchmarks/artificial-analysis.js';
import { matchScores } from '$lib/server/benchmarks/match.js';
import { getMapsInfo } from '$lib/server/maps/service.js';
import { getWebSearchInfo } from '$lib/server/websearch/service.js';
import type { PageServerLoad } from './$types';

/** Third-party services Chatty pulls data from; one entry per service as more are added. */
export const load: PageServerLoad = ({ locals }) => {
	requireAdmin(locals);
	const db = getDb();
	const key = getKeyInfo(db);
	const models = listModels(db).map(modelToPublic);
	const matched = key.source ? Object.keys(matchScores(models, listAaModels(db))).length : 0;
	return {
		artificialAnalysis: {
			aa: { key, status: getStatus(db) },
			matched,
			total: models.length
		},
		webSearch: getWebSearchInfo(db),
		maps: getMapsInfo(db)
	};
};
