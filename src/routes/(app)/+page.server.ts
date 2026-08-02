import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/index.js';
import { listPersonaAgents, toPublic } from '$lib/server/db/repo/agents.js';
import {
	listEnabledModelMappings,
	toPublic as mappingToPublic
} from '$lib/server/db/repo/model-mappings.js';
import { findModel, findRoleModel, listEnabledModels } from '$lib/server/db/repo/models.js';
import { getUserSettings } from '$lib/server/db/repo/user-settings.js';
import { listModelsGrouped } from '$lib/server/llm/registry.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const user = locals.user;
	if (!user) error(401, { message: 'Unauthorized' });
	const db = getDb();
	const roleModel = findRoleModel(db, 'chat');
	let defaultModel: { providerId: string; modelId: string } | null = null;
	if (roleModel) {
		defaultModel = { providerId: roleModel.provider_id, modelId: roleModel.model_id };
	} else {
		const enabled = listEnabledModels(db);
		const first =
			enabled.length > 0 ? findModel(db, enabled[0].provider_id, enabled[0].model_id) : null;
		if (first) {
			defaultModel = { providerId: first.provider_id, modelId: first.model_id };
		}
	}
	return {
		groups: listModelsGrouped(),
		mappings: listEnabledModelMappings(db).map(mappingToPublic),
		defaultModel,
		suggestions: getUserSettings(db, user.id).suggestions,
		personas: listPersonaAgents(db, user.id).map(toPublic)
	};
};
