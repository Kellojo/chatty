import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	listCodingEnvironments,
	toPublic as environmentToPublic
} from '$lib/server/db/repo/coding-environments.js';
import { getAgent, toPublic } from '$lib/server/db/repo/agents.js';
import {
	listEnabledModelMappings,
	toPublic as mappingToPublic
} from '$lib/server/db/repo/model-mappings.js';
import { listModelsGrouped } from '$lib/server/llm/registry.js';
import { listToolInfo } from '$lib/server/tools/registry.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const agent = getAgent(db, params.id);
	if (!agent || (agent.user_id !== null && agent.user_id !== user.id)) {
		error(404, { message: 'Agent not found' });
	}
	return {
		agent: toPublic(agent),
		groups: listModelsGrouped(),
		mappings: listEnabledModelMappings(db).map(mappingToPublic),
		tools: await listToolInfo(user.id),
		codingEnvironments: listCodingEnvironments(db, user.id)
			.filter((row) => row.enabled === 1)
			.map(environmentToPublic)
	};
};
