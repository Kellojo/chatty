import type { Handle } from '@sveltejs/kit';

/**
 * Form posts from other apps' servers that must get through: OAuth token
 * exchange and revocation are form-encoded and arrive with no (or a foreign)
 * Origin. They use no cookies, so cross-site requests can't act as a user.
 */
const EXEMPT_PATHS = new Set(['/api/oauth/token', '/api/oauth/revoke', '/api/oauth/register']);

const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isFormContentType(request: Request): boolean {
	const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
	return FORM_TYPES.includes(type);
}

/**
 * SvelteKit's own cross-site form check (turned off in vite.config.ts with
 * `csrf.trustedOrigins: ['*']`), with the OAuth endpoints above exempt.
 */
export const csrfHandle: Handle = ({ event, resolve }) => {
	const { request, url } = event;
	if (
		UNSAFE_METHODS.has(request.method) &&
		isFormContentType(request) &&
		request.headers.get('origin') !== url.origin &&
		!EXEMPT_PATHS.has(url.pathname)
	) {
		const message = `Cross-site ${request.method} form submissions are forbidden`;
		return request.headers.get('accept') === 'application/json'
			? new Response(JSON.stringify({ message }), {
					status: 403,
					headers: { 'content-type': 'application/json' }
				})
			: new Response(message, { status: 403 });
	}
	return resolve(event);
};
