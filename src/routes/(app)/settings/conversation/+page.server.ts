import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { findRoleModel } from '$lib/server/db/repo/models.js';
import { getUserSettings } from '$lib/server/db/repo/user-settings.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const user = requireUser(locals);
	const db = getDb();
	return {
		settings: getUserSettings(db, user.id),
		/** Read-aloud uses the Text to speech default; otherwise the browser's voice. */
		serverTts: findRoleModel(db, 'text-to-speech') !== undefined
	};
};
