import { json, error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import {
	deleteBranch,
	listMessagesPage,
	toPublicWithBranches
} from '$lib/server/db/repo/messages.js';
import { hasActiveStream } from '$lib/server/chat/streams.js';
import { publishServerEvent } from '$lib/server/events/bus.js';
import { createLogger } from '$lib/server/logger.js';
import { removeAttachmentFile } from '$lib/server/workspaces.js';
import type { RequestHandler } from './$types';

const log = createLogger('branch');

/**
 * Deletes one version of a message (an edit or a regenerated reply) together
 * with everything that follows it. The last remaining version can't be
 * deleted. Returns the active path's newest page, like the switch endpoint.
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	if (!getConversation(db, user.id, params.id)) error(404, { message: 'Conversation not found' });
	// The running reply may sit in the subtree; deleting it mid-stream would
	// leave the stream writing into a message that is gone.
	if (hasActiveStream(params.id)) error(409, { message: 'Wait for the reply to finish' });
	const result = deleteBranch(db, params.id, params.messageId);
	if (!result.ok) {
		error(400, {
			message:
				result.reason === 'only_version'
					? 'The only version of a message cannot be deleted'
					: 'Unknown message id'
		});
	}
	for (const path of result.attachmentPaths) {
		if (!(await removeAttachmentFile(path))) {
			// The daily orphan cleanup removes it later.
			log.warn('Could not remove attachment file of a deleted branch', { path });
		}
	}
	publishServerEvent(user.id, { type: 'conversation.branch_changed', conversationId: params.id });
	const page = listMessagesPage(db, params.id)!;
	return json({
		messages: toPublicWithBranches(db, params.id, page.rows),
		hasOlder: page.hasOlder
	});
};
