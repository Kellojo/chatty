import { getCodingConversation } from '$lib/server/db/repo/coding-conversations.js';
import { privatePlaceholderTitle } from '$lib/server/privacy/background.js';
import { hasTrustedProvider } from '$lib/server/privacy/policy.js';
import { modelRefTrusted as modelTrusted } from '$lib/server/privacy/models.js';
import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getAgent } from '$lib/server/db/repo/agents.js';
import {
	getConversation,
	setConversationPrivate,
	setConversationTitle,
	softDeleteConversation,
	toPublic as conversationToPublic,
	updateConversation
} from '$lib/server/db/repo/conversations.js';
import {
	countMessages,
	listMessagesPage,
	toPublicWithBranches
} from '$lib/server/db/repo/messages.js';
import { dismissRunQuestion } from '$lib/server/agents/run-lifecycle.js';
import { publishServerEvent } from '$lib/server/events/bus.js';
import { archiveCodingThread } from '$lib/server/t3/tasks.js';
import { queueThreadStatePush } from '$lib/server/t3/thread-state.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const conversation = getConversation(db, user.id, params.id);
	if (!conversation) error(404, { message: 'Conversation not found' });
	// The newest page only; older messages come from ./messages?before=<id>.
	const page = listMessagesPage(db, params.id)!;
	return json({
		conversation: conversationToPublic(conversation),
		messages: toPublicWithBranches(db, params.id, page.rows),
		hasOlderMessages: page.hasOlder
	});
};

const patchSchema = z.object({
	title: z.string().max(200).optional(),
	providerId: z.string().nullable().optional(),
	modelId: z.string().nullable().optional(),
	systemPrompt: z.string().max(10000).nullable().optional(),
	memoryEnabled: z.boolean().optional(),
	maxSteps: z.number().int().min(1).max(100).nullable().optional(),
	temperature: z.number().min(0).max(2).nullable().optional(),
	maxTokens: z.number().int().min(1).nullable().optional(),
	agentId: z.string().nullable().optional(),
	/** Turning it on is always allowed; turning it off needs `confirm: true`. */
	private: z.boolean().optional(),
	confirm: z.boolean().optional(),
	/**
	 * With `private: true`: replace the title (which an untrusted title model
	 * may have written) with a placeholder. Not pushed to T3.
	 */
	replaceTitle: z.boolean().optional()
});

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const db = getDb();
	const data = parsed.data;
	if (data.agentId !== undefined) {
		const conversation = getConversation(db, user.id, params.id);
		if (
			conversation &&
			data.agentId !== conversation.agent_id &&
			countMessages(db, params.id) > 0
		) {
			error(409, { message: 'Persona can only be changed before the first message' });
		}
	}
	if (data.agentId != null) {
		const agent = getAgent(db, data.agentId);
		if (!agent || (agent.user_id !== user.id && agent.user_id !== null)) {
			error(404, { message: 'Agent not found' });
		}
		// A private agent's chats are private, as when one is started with it
		// (POST): its prompt is private data.
		if (agent.private === 1) {
			if (data.private === false) {
				error(409, { message: "A private agent's chats are private" });
			}
			data.private = true;
		}
		if (data.systemPrompt === undefined) data.systemPrompt = agent.system_prompt;
		if (agent.provider_id && agent.model_id) {
			if (data.providerId === undefined) data.providerId = agent.provider_id;
			if (data.modelId === undefined) data.modelId = agent.model_id;
		}
	}
	const { private: makePrivate, confirm, replaceTitle, ...fields } = data;
	if (replaceTitle === true && makePrivate !== true) {
		error(400, { message: 'replaceTitle only goes with private: true' });
	}
	const current = getConversation(db, user.id, params.id);
	if (!current) error(404, { message: 'Conversation not found' });
	const willBePrivate = makePrivate ?? current.private === 1;
	if (makePrivate === true && current.private !== 1) {
		if (getCodingConversation(db, current.id)) {
			error(409, { message: 'Coding chats run on a T3 machine and cannot be private' });
		}
		if (!hasTrustedProvider(db)) {
			error(409, { message: 'No provider may process private data yet' });
		}
	}
	if (makePrivate === false && current.private === 1 && confirm !== true) {
		error(409, {
			message: 'Making a private chat public needs confirmation (confirm: true)'
		});
	}
	// A private chat can only be switched to models that may see private data.
	// Making a chat on an untrusted model private is fine: its turns fail closed
	// until a trusted model is picked.
	const switching = fields.providerId !== undefined || fields.modelId !== undefined;
	const providerId = fields.providerId !== undefined ? fields.providerId : current.provider_id;
	const modelId = fields.modelId !== undefined ? fields.modelId : current.model_id;
	if (
		switching &&
		willBePrivate &&
		providerId &&
		modelId &&
		!modelTrusted(db, providerId, modelId)
	) {
		error(409, { message: 'Private chat: pick a model that may process private data' });
	}
	const conversation = updateConversation(db, user.id, params.id, fields);
	if (!conversation) error(404, { message: 'Conversation not found' });
	if (replaceTitle === true) {
		conversation.title = privatePlaceholderTitle();
		setConversationTitle(db, conversation.id, conversation.title);
	}
	if (makePrivate !== undefined && setConversationPrivate(db, conversation.id, makePrivate)) {
		conversation.private = makePrivate ? 1 : 0;
		publishServerEvent(user.id, {
			type: 'conversation.privacy',
			conversationId: conversation.id,
			private: makePrivate
		});
	}
	if (data.title !== undefined) queueThreadStatePush(db, user.id, [conversation.id]);
	return json({ conversation: conversationToPublic(conversation) });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	if (!softDeleteConversation(db, user.id, params.id)) {
		error(404, { message: 'Conversation not found' });
	}
	dismissRunQuestion(db, user.id, params.id, 'Dismissed: chat deleted');
	publishServerEvent(user.id, { type: 'conversation.deleted', conversationId: params.id });
	// A coding task's thread leaves T3's list too (best-effort, in the background).
	void archiveCodingThread(user.id, params.id, db);
	return json({ ok: true });
};
