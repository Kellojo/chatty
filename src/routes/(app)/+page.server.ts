import { error } from '@sveltejs/kit';
import { START_MODE_COOKIE } from '$lib/coding-environments.js';
import { getDb } from '$lib/server/db/index.js';
import { listPersonaAgents, toPublic } from '$lib/server/db/repo/agents.js';
import {
	listCodingEnvironments,
	toPublic as environmentToPublic
} from '$lib/server/db/repo/coding-environments.js';
import {
	listEnabledModelMappings,
	toPublic as mappingToPublic
} from '$lib/server/db/repo/model-mappings.js';
import { findRoleModel, resolveDefaultChatModel } from '$lib/server/db/repo/models.js';
import { getUserSettings } from '$lib/server/db/repo/user-settings.js';
import { modelCatalogInfo } from '$lib/server/llm/model-catalog.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, cookies, isDataRequest }) => {
	const user = locals.user;
	if (!user) error(401, { message: 'Unauthorized' });
	const db = getDb();
	const settings = getUserSettings(db, user.id);
	const chatModel = resolveDefaultChatModel(db);
	const defaultModel = chatModel
		? { providerId: chatModel.provider_id, modelId: chatModel.model_id }
		: null;
	const sttRoleModel = findRoleModel(db, 'speech-to-text');
	let sttModel: { providerId: string; modelId: string } | null = null;
	if (sttRoleModel) {
		sttModel = { providerId: sttRoleModel.provider_id, modelId: sttRoleModel.model_id };
	}
	return {
		// The models themselves only on a full page load; see model-catalog.
		modelCatalog: modelCatalogInfo(isDataRequest),
		mappings: listEnabledModelMappings(db).map(mappingToPublic),
		defaultModel,
		sttModel,
		/** A Text to speech default is set (voice mode reads with it, else the browser's voice). */
		serverTts: findRoleModel(db, 'text-to-speech') !== undefined,
		suggestions: settings.suggestions,
		codingSuggestions: settings.codingSuggestions,
		personas: listPersonaAgents(db, user.id).map(toPublic),
		codingEnvironments: listCodingEnvironments(db, user.id)
			.filter((row) => row.enabled === 1)
			.map(environmentToPublic),
		startMode: (cookies.get(START_MODE_COOKIE) === 'coding' ? 'coding' : 'chat') as
			'chat' | 'coding'
	};
};
