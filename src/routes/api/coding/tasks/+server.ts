import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { CODING_AUTONOMY_VALUES } from '$lib/coding-environments.js';
import type { ProposedCodingTask } from '$lib/coding-task-proposal.js';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	toPublic as codingToPublic,
	listProposedCodingTasks
} from '$lib/server/db/repo/coding-conversations.js';
import {
	toPublic as conversationToPublic,
	getConversation
} from '$lib/server/db/repo/conversations.js';
import { codingRoute } from '$lib/server/t3/http.js';
import {
	createCodingDraft,
	createCodingTask,
	launchCodingTask,
	MAX_LAUNCH_PROMPT
} from '$lib/server/t3/tasks.js';
import type { RequestHandler } from './$types';

const id = z.string().trim().min(1).max(256);

const createSchema = z.object({
	environmentId: id,
	projectId: id,
	providerInstanceId: id,
	model: id,
	autonomy: z.enum(CODING_AUTONOMY_VALUES),
	workspaceMode: z.enum(['worktree', 'local']),
	baseBranch: z.string().trim().min(1).max(256).optional(),
	/** When given, the task starts right away with this as its first message (hand-offs). */
	prompt: z.string().trim().min(1).max(MAX_LAUNCH_PROMPT).optional(),
	/** The task's title when it starts with `prompt`; drawn from the prompt otherwise. */
	title: z.string().trim().min(1).max(200).optional(),
	/** The chat's `propose_coding_task` call this starts; each starts one task. */
	proposal: z.object({ conversationId: id, toolCallId: id }).optional(),
	/**
	 * Saves the task as a draft without reaching the environment (it's offline),
	 * titled with the project's last known title. Started later by the user.
	 */
	draft: z.object({ projectTitle: z.string().trim().min(1).max(200) }).optional()
});

/** `?proposedIn=<chat id>`: the tasks started from that chat's proposals. */
export const GET: RequestHandler = async ({ locals, url }) => {
	const user = requireUser(locals);
	const chatId = url.searchParams.get('proposedIn');
	if (!chatId) error(400, { message: 'proposedIn is required' });
	const db = getDb();
	if (!getConversation(db, user.id, chatId)) error(404, { message: 'Chat not found' });
	const tasks: ProposedCodingTask[] = listProposedCodingTasks(db, chatId).map((row) => ({
		toolCallId: row.proposed_tool_call_id ?? '',
		conversationId: row.conversation_id,
		title: row.title,
		coding: codingToPublic(row)
	}));
	return json({ tasks });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = createSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const { prompt, title, proposal, draft, ...target } = parsed.data;
	if (draft && (prompt || proposal)) {
		error(400, { message: 'A draft starts from its chat, not with a prompt or proposal' });
	}
	const { conversation, coding } = await codingRoute(async () =>
		draft
			? createCodingDraft(user.id, { ...target, projectTitle: draft.projectTitle })
			: prompt
				? launchCodingTask(user.id, { ...target, prompt, title }, undefined, { proposal })
				: createCodingTask(user.id, target, undefined, { title, proposal })
	);
	return json(
		{ conversation: conversationToPublic(conversation), coding: codingToPublic(coding) },
		{ status: 201 }
	);
};
