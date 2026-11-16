import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/index.js';
import { findSourceSite } from '$lib/server/db/repo/source-sites.js';
import { untrustedFileHeaders } from '$lib/server/http/untrustedFile.js';
import { loadSiteIcon } from '$lib/server/net/favicon.js';
import type { RequestHandler } from './$types';

/**
 * The favicon of a site the user's tools fetched, for the ```links source cards.
 *
 * Model output may only load inline or same-origin images (see image-url.ts),
 * so source cards ask here instead of loading the site's icon directly. Only
 * hosts recorded from the user's own tool results are served: a hostname the
 * model made up (say `<chat data>.evil.com`) is never resolved or contacted.
 * Failures are a bodyless 404, so the card falls back to its monogram.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) error(401, { message: 'Unauthorized' });
	const host = url.searchParams.get('host') ?? '';
	if (!host || host.length > 253) return notFound();
	const site = findSourceSite(getDb(), locals.user.id, host);
	if (!site) return notFound();
	const icon = await loadSiteIcon(site);
	if (!icon) return notFound();
	return new Response(new Uint8Array(icon.body), {
		headers: {
			'content-type': icon.type,
			'cache-control': 'private, max-age=86400',
			...untrustedFileHeaders(icon.type)
		}
	});
};

function notFound(): Response {
	return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
}
