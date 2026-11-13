import { json, error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { apiKeyUpdateSchema } from '$lib/server/auth/apiKeyInput.js';
import { getDb } from '$lib/server/db/index.js';
import { deleteApiKey, toPublic, updateApiKey } from '$lib/server/db/repo/api-keys.js';
import type { RequestHandler } from './$types';

/** Changes a key's label, scopes or MCP gateway access; the secret stays the same. */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const parsed = apiKeyUpdateSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const row = updateApiKey(getDb(), params.id, user.id, parsed.data);
	if (!row) error(404, { message: 'API key not found' });
	return json({ key: toPublic(row) });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!deleteApiKey(getDb(), params.id, user.id)) {
		error(404, { message: 'API key not found' });
	}
	return json({ ok: true });
};
