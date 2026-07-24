import { error, redirect } from '@sveltejs/kit';
import { hasActiveStream } from '$lib/server/chat/streams.js';
import { getDb } from '$lib/server/db/index.js';
import { listPersonaAgents, toPublic as agentToPublic } from '$lib/server/db/repo/agents.js';
import {
	listEnabledModelMappings,
	toPublic as mappingToPublic
} from '$lib/server/db/repo/model-mappings.js';
import { findModel, findRoleModel, listEnabledModels } from '$lib/server/db/repo/models.js';
import {
	getConversation,
	toPublic as conversationToPublic
} from '$lib/server/db/repo/conversations.js';
import { listMessages, toPublic as messageToPublic } from '$lib/server/db/repo/messages.js';
import { getTimeFormat } from '$lib/server/db/repo/user-settings.js';
import { listModelsGrouped } from '$lib/server/llm/registry.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
	const user = locals.user;
	if (!user) error(401, { message: 'Unauthorized' });
	const db = getDb();
	const conversation = getConversation(db, user.id, params.id);
	if (!conversation || conversation.kind !== 'chat') redirect(303, '/?error=conversation-not-found');
	const roleModel = findRoleModel(db, 'chat');
	let defaultModel: { providerId: string; modelId: string } | null = null;
	if (roleModel) {
		defaultModel = { providerId: roleModel.provider_id, modelId: roleModel.model_id };
	} else {
		const enabled = listEnabledModels(db);
		const first = enabled.length > 0 ? findModel(db, enabled[0].provider_id, enabled[0].model_id) : null;
		if (first) {
			defaultModel = { providerId: first.provider_id, modelId: first.model_id };
		}
	}
	return {
		conversation: conversationToPublic(conversation),
		messages: listMessages(db, conversation.id).map(messageToPublic),
		groups: listModelsGrouped(),
		mappings: listEnabledModelMappings(db).map(mappingToPublic),
		defaultModel,
		timeFormat: getTimeFormat(db, user.id),
		personas: listPersonaAgents(db, user.id).map(agentToPublic),
		generating: hasActiveStream(conversation.id)
	};
};
