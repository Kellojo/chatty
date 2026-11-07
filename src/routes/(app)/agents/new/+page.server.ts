import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	listCodingEnvironments,
	toPublic as environmentToPublic
} from '$lib/server/db/repo/coding-environments.js';
import {
	listEnabledModelMappings,
	toPublic as mappingToPublic
} from '$lib/server/db/repo/model-mappings.js';
import { listModelsGrouped } from '$lib/server/llm/registry.js';
import { listToolInfo } from '$lib/server/tools/registry.js';
import { getTimeFormat } from '$lib/server/db/repo/user-settings.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);
	const db = getDb();
	return {
		groups: listModelsGrouped(),
		mappings: listEnabledModelMappings(db).map(mappingToPublic),
		tools: await listToolInfo(user.id),
		codingEnvironments: listCodingEnvironments(db, user.id)
			.filter((row) => row.enabled === 1)
			.map(environmentToPublic),
		timeFormat: getTimeFormat(db, user.id)
	};
};
