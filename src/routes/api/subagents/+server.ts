import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { findSubagentForToolCall } from '$lib/server/agents/subagents.js';
import { getDb } from '$lib/server/db/index.js';
import type { RequestHandler } from './$types';

/** `?parent=<conversation>&toolCallId=<call>`: the subagent that `run_subagent` call started. */
export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	const parent = url.searchParams.get('parent');
	const toolCallId = url.searchParams.get('toolCallId');
	if (!parent || !toolCallId) error(400, { message: 'parent and toolCallId are required' });
	return json({ subagent: findSubagentForToolCall(getDb(), user.id, parent, toolCallId) });
};
