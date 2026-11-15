// The service worker keeps signed-in data for offline reading (runtime caches in
// vite.config.ts). Cache Storage belongs to the browser, not the account: it
// outlives sign-out, and the same URLs serve every user, so a slow network could
// show the next account the last one's chats. These helpers drop it whenever the
// account on this device ends or changes.
//
// Kept free of `$lib` imports: vite.config.ts imports the cache names.

/** Runtime caches holding one account's chats. */
export const USER_DATA_CACHES = {
	conversations: 'api-conversations',
	chatPageData: 'chat-page-data',
	olderMessages: 'chat-older-messages'
} as const;

/** The account whose data the caches hold. */
const OWNER_KEY = 'chatty.cache.owner';

/** Deletes every cache holding account data. Never throws. */
export async function clearUserDataCaches(): Promise<void> {
	try {
		localStorage.removeItem(OWNER_KEY);
	} catch {
		// storage unavailable: nothing to forget
	}
	if (typeof caches === 'undefined') return;
	await Promise.all(
		Object.values(USER_DATA_CACHES).map((name) => caches.delete(name).catch(() => false))
	);
}

/**
 * Records `userId` as the account the caches belong to, clearing them first if
 * they were filled by someone else (or by an account that wasn't recorded).
 */
export async function claimUserDataCaches(userId: string): Promise<void> {
	let owner: string | null = null;
	try {
		owner = localStorage.getItem(OWNER_KEY);
	} catch {
		// storage unavailable: clear to be safe
	}
	if (owner === userId) return;
	await clearUserDataCaches();
	try {
		localStorage.setItem(OWNER_KEY, userId);
	} catch {
		// storage unavailable: the next start clears again, which is safe
	}
}
