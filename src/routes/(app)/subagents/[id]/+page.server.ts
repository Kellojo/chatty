import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { describeSubagent } from '$lib/server/agents/subagents.js';
import { getDb } from '$lib/server/db/index.js';
import { listMessages, toPublic as messageToPublic } from '$lib/server/db/repo/messages.js';
import { getTimeFormat } from '$lib/server/db/repo/user-settings.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const subagent = describeSubagent(db, user.id, params.id);
	if (!subagent) error(404, { message: 'Subagent not found' });
	return {
		subagent,
		messages: listMessages(db, subagent.id).map(messageToPublic),
		timeFormat: getTimeFormat(db, user.id)
	};
};
