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
import { buildTools } from '$lib/server/tools/registry.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);
	const db = getDb();
	const built = await buildTools({ userId: user.id, memoryEnabled: true });
	try {
		const tools = Object.entries(built.tools)
			.map(([name, t]) => ({
				name,
				description: typeof t.description === 'string' ? t.description : '',
				server: built.toolToServer[name] ?? ''
			}))
			.sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name));
		return {
			groups: listModelsGrouped(),
			mappings: listEnabledModelMappings(db).map(mappingToPublic),
			tools,
			codingEnvironments: listCodingEnvironments(db, user.id)
				.filter((row) => row.enabled === 1)
				.map(environmentToPublic)
		};
	} finally {
		await built.close();
	}
};
