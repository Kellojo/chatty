import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getUserSettings } from '$lib/server/db/repo/user-settings.js';
import { isPrivateDataEnabled } from '$lib/server/privacy/feature.js';
import { trustedProviderNames } from '$lib/server/privacy/status.js';
import type { PageServerLoad } from './$types';

/**
 * Everything about private data in one place: the admin's switch for the
 * instance, and each user's own preference once it's on.
 */
export const load: PageServerLoad = ({ locals }) => {
	const user = requireUser(locals);
	const db = getDb();
	return {
		isAdmin: (user as { role?: string }).role === 'admin',
		privateDataEnabled: isPrivateDataEnabled(db),
		privateByDefault: getUserSettings(db, user.id).privateByDefault,
		/** Named in the diagram; no secret, the model picker shows provider names too. */
		trustedProviders: trustedProviderNames(db)
	};
};
