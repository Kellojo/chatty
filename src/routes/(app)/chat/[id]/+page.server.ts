import { error, redirect } from '@sveltejs/kit';
import { hasActiveStream } from '$lib/server/chat/streams.js';
import {
	getCodingConversation,
	toPublic as codingToPublic
} from '$lib/server/db/repo/coding-conversations.js';
import { getDb } from '$lib/server/db/index.js';
import {
	getAgent,
	listAgents,
	listPersonaAgents,
	toPublic as agentToPublic
} from '$lib/server/db/repo/agents.js';
import {
	listCodingEnvironments,
	toPublic as environmentToPublic
} from '$lib/server/db/repo/coding-environments.js';
import {
	listEnabledModelMappings,
	toPublic as mappingToPublic
} from '$lib/server/db/repo/model-mappings.js';
import { findModel, findRoleModel, listEnabledModels } from '$lib/server/db/repo/models.js';
import {
	getConversation,
	toPublic as conversationToPublic
} from '$lib/server/db/repo/conversations.js';
import { listMessagesPage, toPublicWithBranches } from '$lib/server/db/repo/messages.js';
import { getAgentRunByConversation } from '$lib/server/db/repo/agent-runs.js';
import type { DispatchInfo } from '$lib/types.js';
import { getTimeFormat } from '$lib/server/db/repo/user-settings.js';
import { modelCatalogInfo } from '$lib/server/llm/model-catalog.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params, isDataRequest }) => {
	const user = locals.user;
	if (!user) error(401, { message: 'Unauthorized' });
	const db = getDb();
	const conversation = getConversation(db, user.id, params.id);
	if (!conversation || conversation.kind !== 'chat')
		redirect(303, '/?error=conversation-not-found');
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
	const sttRoleModel = findRoleModel(db, 'speech-to-text');
	let sttModel: { providerId: string; modelId: string } | null = null;
	if (sttRoleModel) {
		sttModel = { providerId: sttRoleModel.provider_id, modelId: sttRoleModel.model_id };
	}
	const coding = getCodingConversation(db, conversation.id);
	let dispatch: DispatchInfo | null = null;
	if (conversation.origin === 'dispatch') {
		const run = getAgentRunByConversation(db, conversation.id);
		const agent = run ? getAgent(db, run.agent_id) : undefined;
		dispatch = {
			runId: run?.id ?? '',
			agentId: run?.agent_id ?? conversation.agent_id ?? '',
			agentName: agent?.name ?? null,
			trigger: (run?.trigger as DispatchInfo['trigger']) ?? null,
			startedAt: run?.started_at ?? null,
			status: (run?.status as DispatchInfo['status']) ?? null
		};
	}
	// Older messages are fetched on demand from /api/conversations/[id]/messages.
	const page = listMessagesPage(db, conversation.id)!;
	return {
		conversation: conversationToPublic(conversation),
		coding: coding ? codingToPublic(coding) : null,
		dispatch,
		messages: toPublicWithBranches(db, conversation.id, page.rows),
		hasOlderMessages: page.hasOlder,
		// The models themselves only on a full page load; see model-catalog.
		modelCatalog: modelCatalogInfo(isDataRequest),
		mappings: listEnabledModelMappings(db).map(mappingToPublic),
		defaultModel,
		sttModel,
		timeFormat: getTimeFormat(db, user.id),
		personas: listPersonaAgents(db, user.id).map(agentToPublic),
		// For handing a chat off to a coding agent (not needed inside coding tasks).
		codingEnvironments: coding
			? []
			: listCodingEnvironments(db, user.id)
					.filter((row) => row.enabled === 1)
					.map(environmentToPublic),
		codingAgents: coding
			? []
			: listAgents(db, user.id)
					.filter((row) => row.user_id === user.id && row.coding_target)
					.map(agentToPublic),
		generating: hasActiveStream(conversation.id)
	};
};
