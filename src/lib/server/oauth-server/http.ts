import { json } from '@sveltejs/kit';

/**
 * OAuth endpoints are called by other apps, some from a browser (e.g. MCP
 * inspectors), and never rely on cookies, so any origin may read them.
 */
export const CORS_HEADERS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, OPTIONS',
	'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
	'access-control-expose-headers': 'www-authenticate'
};

/** Answers a CORS preflight. */
export function preflight(): Response {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** A JSON response that is never cached (RFC 6749 §5.1). */
export function oauthJson(body: unknown, status = 200): Response {
	return json(body, {
		status,
		headers: { ...CORS_HEADERS, 'cache-control': 'no-store', pragma: 'no-cache' }
	});
}

/** An OAuth error response (RFC 6749 §5.2). */
export function oauthError(error: string, description: string, status = 400): Response {
	return oauthJson({ error, error_description: description }, status);
}

/** The body of a token, revocation or registration request: form-encoded, or JSON as a courtesy. */
export async function readParams(request: Request): Promise<URLSearchParams> {
	const type = request.headers.get('content-type') ?? '';
	if (type.includes('application/json')) {
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(body ?? {})) {
			if (typeof v === 'string') params.set(k, v);
		}
		return params;
	}
	return new URLSearchParams(await request.text().catch(() => ''));
}
