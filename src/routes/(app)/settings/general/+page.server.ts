import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { listProviders } from '$lib/server/db/repo/providers.js';
import { isPrivateDataEnabled } from '$lib/server/privacy/feature.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	requireAdmin(locals);
	const db = getDb();
	return {
		privateDataEnabled: isPrivateDataEnabled(db),
		/** Enabled providers trusted with private data, named in the section's hint. */
		trustedProviders: listProviders(db)
			.filter((p) => p.enabled === 1 && p.allow_private === 1)
			.map((p) => p.name)
	};
};
