import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { CODING_AUTONOMY_VALUES } from '$lib/coding-environments.js';
import { requireUser } from '$lib/server/auth/guards.js';
import { toPublic as codingToPublic } from '$lib/server/db/repo/coding-conversations.js';
import { toPublic as conversationToPublic } from '$lib/server/db/repo/conversations.js';
import { codingRoute } from '$lib/server/t3/http.js';
import { createCodingTask } from '$lib/server/t3/tasks.js';
import type { RequestHandler } from './$types';

const id = z.string().trim().min(1).max(256);

const createSchema = z.object({
	environmentId: id,
	projectId: id,
	providerInstanceId: id,
	model: id,
	autonomy: z.enum(CODING_AUTONOMY_VALUES),
	workspaceMode: z.enum(['worktree', 'local']),
	baseBranch: z.string().trim().min(1).max(256).optional()
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = createSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const { conversation, coding } = await codingRoute(() => createCodingTask(user.id, parsed.data));
	return json(
		{ conversation: conversationToPublic(conversation), coding: codingToPublic(coding) },
		{ status: 201 }
	);
};
