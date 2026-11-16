import type { Db } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import type { Privacy } from '$lib/server/privacy/policy.js';

/**
 * The privacy of a speech request, from the chat it belongs to:
 * - `conversationId`: the caller's own chat; the speech choke points re-read
 *   its private flag (ORed with `private: true` if also sent);
 * - `private` alone: an unsaved new chat, as the client's toggle says;
 * - neither: unknown, so treated as private (fails closed).
 * Returns null when `conversationId` isn't one of the user's chats.
 */
export function speechRequestPrivacy(
	db: Db,
	userId: string,
	fields: { conversationId?: unknown; private?: unknown }
): Privacy | null {
	const flag =
		fields.private === true || fields.private === 'true'
			? true
			: fields.private === false || fields.private === 'false'
				? false
				: null;
	const conversationId =
		typeof fields.conversationId === 'string' && fields.conversationId
			? fields.conversationId
			: null;
	if (conversationId) {
		if (!getConversation(db, userId, conversationId)) return null;
		return { tainted: flag === true, conversationId };
	}
	if (flag !== null) return { tainted: flag };
	return { tainted: true, reason: 'speech request without a chat' };
}
