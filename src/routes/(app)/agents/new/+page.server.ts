import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	listEnabledModelMappings,
	toPublic as mappingToPublic
} from '$lib/server/db/repo/model-mappings.js';
import { listModelsGrouped } from '$lib/server/llm/registry.js';
import { listToolInfo } from '$lib/server/tools/registry.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);
	const db = getDb();
	return {
		groups: listModelsGrouped(),
		mappings: listEnabledModelMappings(db).map(mappingToPublic),
		tools: await listToolInfo(user.id)
	};
};
