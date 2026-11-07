import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Moved under the Usage section; keep old links and bookmarks working.
export const load: PageServerLoad = ({ url }) => {
	redirect(308, `/usage/requests${url.search}`);
};
