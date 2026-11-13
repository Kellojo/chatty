import { redirect } from '@sveltejs/kit';
import { config } from '$lib/server/config.js';
import { safeRedirectPath } from '$lib/redirect-to.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (locals.user) redirect(302, safeRedirectPath(url.searchParams.get('redirectTo')));
	return {
		authConfig: {
			passwordLogin: config.ENABLE_PASSWORD_LOGIN && !config.OIDC_ONLY,
			signup: config.ENABLE_SIGNUP && !config.OIDC_ONLY,
			oidc: Boolean(config.OIDC_ISSUER)
		}
	};
};
