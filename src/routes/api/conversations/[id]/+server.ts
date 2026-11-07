import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getAgent } from '$lib/server/db/repo/agents.js';
import {
	getConversation,
	softDeleteConversation,
	toPublic as conversationToPublic,
	updateConversation
} from '$lib/server/db/repo/conversations.js';
import {
	countMessages,
	listMessages,
	toPublic as messageToPublic
} from '$lib/server/db/repo/messages.js';
import { queueThreadStatePush } from '$lib/server/t3/thread-state.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const conversation = getConversation(db, user.id, params.id);
	if (!conversation) error(404, { message: 'Conversation not found' });
	return json({
		conversation: conversationToPublic(conversation),
		messages: listMessages(db, params.id).map(messageToPublic)
	});
};

const patchSchema = z.object({
	title: z.string().max(200).optional(),
	mode: z.enum(['chat', 'agent']).optional(),
	providerId: z.string().nullable().optional(),
	modelId: z.string().nullable().optional(),
	systemPrompt: z.string().max(10000).nullable().optional(),
	memoryEnabled: z.boolean().optional(),
	maxSteps: z.number().int().min(1).max(100).nullable().optional(),
	temperature: z.number().min(0).max(2).nullable().optional(),
	maxTokens: z.number().int().min(1).nullable().optional(),
	agentId: z.string().nullable().optional()
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
		if (data.systemPrompt === undefined) data.systemPrompt = agent.system_prompt;
		if (agent.provider_id && agent.model_id) {
			if (data.providerId === undefined) data.providerId = agent.provider_id;
			if (data.modelId === undefined) data.modelId = agent.model_id;
		}
	}
	const conversation = updateConversation(db, user.id, params.id, data);
	if (!conversation) error(404, { message: 'Conversation not found' });
	if (data.title !== undefined) queueThreadStatePush(db, user.id, [conversation.id]);
	return json({ conversation: conversationToPublic(conversation) });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!softDeleteConversation(getDb(), user.id, params.id)) {
		error(404, { message: 'Conversation not found' });
	}
	return json({ ok: true });
};
