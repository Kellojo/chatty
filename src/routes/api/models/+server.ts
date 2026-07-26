import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin, requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { createModel, findModel, toPublic } from '$lib/server/db/repo/models.js';
import { getProvider } from '$lib/server/db/repo/providers.js';
import { listModelsGrouped } from '$lib/server/llm/registry.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	return json({ groups: listModelsGrouped() });
};

const createSchema = z.object({
	providerId: z.string().min(1),
	modelId: z.string().min(1).max(200),
	displayName: z.string().min(1).max(200).optional(),
	capabilities: z.array(z.enum(['chat', 'vision', 'tool_use', 'streaming', 'image'])).optional()
});

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const parsed = createSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const db = getDb();
	if (!getProvider(db, parsed.data.providerId)) error(404, { message: 'Provider not found' });
	if (findModel(db, parsed.data.providerId, parsed.data.modelId)) {
		error(409, { message: 'Model already exists for this provider' });
	}
	const model = createModel(db, parsed.data);
	return json({ model: toPublic(model) }, { status: 201 });
};
