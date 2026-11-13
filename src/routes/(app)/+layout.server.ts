import { redirect } from '@sveltejs/kit';
import { CONVERSATIONS_KEY } from '$lib/load-keys.js';
import { config } from '$lib/server/config.js';
import { getDb } from '$lib/server/db/index.js';
import {
	CONVERSATIONS_PAGE_SIZE,
	countSettledConversations,
	listConversations,
	listSnoozedConversations,
	listUnreadChatIds,
	toPublic
} from '$lib/server/db/repo/conversations.js';
import { getUserSettings } from '$lib/server/db/repo/user-settings.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, depends }) => {
	if (!locals.user) redirect(302, '/login');
	// Read markers and stream events refresh just this (see invalidateWhenIdle).
	depends(CONVERSATIONS_KEY);
	const db = getDb();
	const settings = getUserSettings(db, locals.user.id);
	const rows = listConversations(db, locals.user.id, { limit: CONVERSATIONS_PAGE_SIZE + 1 });
	return {
		user: {
			id: locals.user.id,
			name: locals.user.name,
			email: locals.user.email,
			image: locals.user.image ?? null,
			role: (locals.user as { role?: string }).role ?? 'user'
		},
		conversations: rows.slice(0, CONVERSATIONS_PAGE_SIZE).map(toPublic),
		hasMoreConversations: rows.length > CONVERSATIONS_PAGE_SIZE,
		snoozed: listSnoozedConversations(db, locals.user.id).map(toPublic),
		settledCount: countSettledConversations(db, locals.user.id),
		autoSettleDays: config.CONVERSATION_AUTO_SETTLE_DAYS,
		unreadIds: listUnreadChatIds(db, locals.user.id),
		sidebarOpen: settings.sidebarOpen,
		settings
	};
};
