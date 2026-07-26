import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	listModels,
	listRoleDefaults,
	toPublic as modelToPublic
} from '$lib/server/db/repo/models.js';
import {
	listEnabledModelMappings,
	toPublic as mappingToPublic
} from '$lib/server/db/repo/model-mappings.js';
import { listProviders, toPublic as providerToPublic } from '$lib/server/db/repo/providers.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	requireAdmin(locals);
	const db = getDb();
	const models = listModels(db).map(modelToPublic);
	const capsByRef = new Map(models.map((m) => [`${m.providerId}/${m.modelId}`, m.capabilities]));
	const mappings = listEnabledModelMappings(db).map((row) => {
		const mapping = mappingToPublic(row);
		const capabilities = [
			...new Set(
				mapping.targets.flatMap((t) => capsByRef.get(`${t.providerId}/${t.modelId}`) ?? [])
			)
		];
		return { ...mapping, capabilities };
	});
	return {
		providers: listProviders(db).map(providerToPublic),
		models,
		mappings,
		roles: listRoleDefaults(db)
	};
};
