import { json, error } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { createProvider, listProviders, toPublic } from '$lib/server/db/repo/providers.js';
import { providerCreateSchema } from '$lib/server/llm/provider-input.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json({ providers: listProviders(getDb()).map(toPublic) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const parsed = providerCreateSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const provider = createProvider(getDb(), parsed.data);
	return json({ provider: toPublic(provider) }, { status: 201 });
};
