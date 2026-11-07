import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Moved under the Usage section; keep old links and bookmarks working.
export const load: PageServerLoad = ({ params, url }) => {
	redirect(308, `/usage/requests/${encodeURIComponent(params.id)}${url.search}`);
};
