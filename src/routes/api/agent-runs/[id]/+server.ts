import { json, error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getAgentRun, toPublic } from '$lib/server/db/repo/agent-runs.js';
import {
	listMessages,
	listMessagesFrom,
	toPublic as messageToPublic
} from '$lib/server/db/repo/messages.js';
import type { RequestHandler } from './$types';

/**
 * Returns the run and its transcript. With `?from=<messageId>` only the
 * messages from that one (inclusive) onwards are returned, and `from` echoes
 * the anchor; when the anchor is unknown the full transcript is returned with
 * `from: null`, so clients must then replace rather than merge.
 */
export const GET: RequestHandler = ({ locals, params, url }) => {
	const user = requireUser(locals);
	const db = getDb();
	const run = getAgentRun(db, params.id);
	if (!run || (run.user_id !== user.id && (user as { role?: string }).role !== 'admin')) {
		error(404, { message: 'Agent run not found' });
	}
	if (!run.conversation_id) return json({ run: toPublic(run), messages: [], from: null });

	const from = url.searchParams.get('from');
	const tail = from ? listMessagesFrom(db, run.conversation_id, from) : undefined;
	const rows = tail ?? listMessages(db, run.conversation_id);
	return json({
		run: toPublic(run),
		messages: rows.map(messageToPublic),
		from: tail ? from : null
	});
};
