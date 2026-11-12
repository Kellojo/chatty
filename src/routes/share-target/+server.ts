import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Shares (manifest `share_target`) are normally taken by the service worker,
// which keeps the files (static/share-target-sw.js). This only runs when no
// service worker is in control: the shared text still opens a new chat, but the
// files can't be handed over without one.
export const POST: RequestHandler = async ({ request }) => {
	const target = new URLSearchParams();
	const form = await request.formData().catch(() => null);
	for (const key of ['share_title', 'share_text', 'share_url']) {
		const value = form?.get(key);
		if (typeof value === 'string' && value.trim()) target.set(key, value);
	}
	if (target.size === 0) target.set('share_text', '');
	redirect(303, `/?${target}`);
};
