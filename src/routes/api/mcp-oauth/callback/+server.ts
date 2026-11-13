import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/index.js';
import { createLogger } from '$lib/server/logger.js';
import { describeError, finishMcpOAuth } from '$lib/server/mcp/oauth.js';
import { invalidateMcpServerForUser } from '$lib/server/mcp/pool.js';
import type { RequestHandler } from './$types';

const log = createLogger('mcp-oauth');
const RETURN_PATH = '/settings/connections';

function back(params: Record<string, string>): never {
	redirect(303, `${RETURN_PATH}?${new URLSearchParams(params)}`);
}

/** The authorization server sends the browser here after the user signed in (or declined). */
export const GET: RequestHandler = async ({ locals, url }) => {
	// Signed out meanwhile: the sign-in can't be tied to anyone, so start over after logging in.
	if (!locals.user) redirect(303, '/login');

	const state = url.searchParams.get('state');
	const code = url.searchParams.get('code');
	const providerError = url.searchParams.get('error');
	if (providerError) {
		back({ error: url.searchParams.get('error_description') || providerError });
	}
	if (!state || !code) back({ error: 'The sign-in response was incomplete.' });

	let serverName: string;
	try {
		const row = await finishMcpOAuth(
			getDb(),
			{ state, code, issuer: url.searchParams.get('iss') },
			locals.user.id,
			url.origin
		);
		invalidateMcpServerForUser(row.id, locals.user.id);
		serverName = row.name;
	} catch (e) {
		// Include the underlying cause: fetch alone only says "fetch failed".
		const message = describeError(e);
		log.warn('Completing MCP OAuth sign-in failed', { error: message });
		back({ error: message });
	}
	back({ connected: serverName });
};
