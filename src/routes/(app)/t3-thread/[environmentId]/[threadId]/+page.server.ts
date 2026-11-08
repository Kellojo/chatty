import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/index.js';
import { findThreadConversationForUser } from '$lib/server/db/repo/coding-conversations.js';
import { listCodingEnvironments } from '$lib/server/db/repo/coding-environments.js';
import { createLogger } from '$lib/server/logger.js';
import { importHistoryThreads } from '$lib/server/t3/history.js';
import type { PageServerLoad } from './$types';

const log = createLogger('t3-thread-link');

/**
 * Target of `t3-thread://v2/<environmentId>/<threadId>` links in messages:
 * opens the thread's coding conversation, importing the thread first when it
 * isn't in Chatty yet.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	const db = getDb();
	const userId = locals.user.id;
	const { environmentId, threadId } = params;

	const existing = findThreadConversationForUser(db, userId, environmentId, threadId);
	if (existing) redirect(303, `/chat/${existing.conversationId}`);

	// Environments of the T3 server the link names; without one, any of the
	// user's (older environments don't know their server's id).
	const enabled = listCodingEnvironments(db, userId).filter((env) => env.enabled === 1);
	const matching = enabled.filter((env) => env.remote_environment_id === environmentId);
	for (const env of matching.length > 0 ? matching : enabled) {
		let imported: string[];
		try {
			imported = await importHistoryThreads(db, env, [threadId]);
		} catch (e) {
			log.warn('Could not import a linked T3 thread', {
				environmentId: env.id,
				error: e instanceof Error ? e.message : String(e)
			});
			continue;
		}
		if (imported[0]) redirect(303, `/chat/${imported[0]}`);
	}
	error(404, { message: 'This T3 Code thread is not available in Chatty' });
};
