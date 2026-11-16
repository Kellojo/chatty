import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { isPrivateDataEnabled } from '$lib/server/privacy/feature.js';
import { trustedProviderNames } from '$lib/server/privacy/status.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	requireAdmin(locals);
	const db = getDb();
	return {
		privateDataEnabled: isPrivateDataEnabled(db),
		/** Enabled providers trusted with private data, named in the section's hint. */
		trustedProviders: trustedProviderNames(db)
	};
};
