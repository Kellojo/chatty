import { untrustedFileHeaders } from '$lib/server/http/untrustedFile.js';
import { createLogger } from '$lib/server/logger.js';
import type { Image } from '$lib/server/maps/google.js';

const log = createLogger('maps');

/** Google's own caching headers when it sent some, else a day in the browser only. */
export function imageResponse(image: Image): Response {
	return new Response(image.body, {
		headers: {
			'content-type': image.type,
			'cache-control': image.cacheControl ?? 'private, max-age=86400',
			...untrustedFileHeaders(image.type)
		}
	});
}

/** Bodyless, so the map shows its blank tile or the place its placeholder. */
export function noImage(status = 404): Response {
	return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

/** Loads an image from Google; a failure is logged and answered without a body. */
export async function proxyImage(what: string, load: () => Promise<Image | null>) {
	try {
		const image = await load();
		return image ? imageResponse(image) : noImage();
	} catch (e) {
		log.warn(`Google ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
		return noImage(502);
	}
}
