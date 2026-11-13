import { json, error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { apiKeyCreateSchema } from '$lib/server/auth/apiKeyInput.js';
import { getDb } from '$lib/server/db/index.js';
import { createApiKey, listApiKeys, toPublic } from '$lib/server/db/repo/api-keys.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json({ keys: listApiKeys(getDb(), user.id).map(toPublic) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = apiKeyCreateSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const { row, rawKey } = await createApiKey(getDb(), { userId: user.id, ...parsed.data });
	return json({ key: { ...toPublic(row), rawKey } }, { status: 201 });
};
