import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb, type Db } from '$lib/server/db/index.js';
import {
	deleteModelMapping,
	getModelMappingByName,
	toPublic,
	updateModelMapping
} from '$lib/server/db/repo/model-mappings.js';
import { findModel } from '$lib/server/db/repo/models.js';
import { getProvider } from '$lib/server/db/repo/providers.js';
import type { ModelMappingTarget } from '$lib/types.js';
import type { RequestHandler } from './$types';

const targetSchema = z.object({
	providerId: z.string().min(1),
	modelId: z.string().min(1).max(200)
});

const nameSchema = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/, 'Invalid name');

const patchSchema = z.object({
	name: nameSchema.optional(),
	targets: z.array(targetSchema).min(1).max(10).optional(),
	enabled: z.boolean().optional(),
	/** Only route to providers trusted with private data (API callers' payloads too). */
	trustedOnly: z.boolean().optional()
});

function validateTargets(db: Db, targets: ModelMappingTarget[]): void {
	for (const target of targets) {
		if (!getProvider(db, target.providerId) || !findModel(db, target.providerId, target.modelId)) {
			error(400, { message: 'Unknown target provider/model' });
		}
	}
}

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireAdmin(locals);
	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const db = getDb();
	if (parsed.data.name !== undefined) {
		const existing = getModelMappingByName(db, parsed.data.name);
		if (existing && existing.id !== params.id) error(400, { message: 'Name already in use' });
	}
	if (parsed.data.targets !== undefined) validateTargets(db, parsed.data.targets);
	const mapping = updateModelMapping(db, params.id, parsed.data);
	if (!mapping) error(404, { message: 'Mapping not found' });
	return json({ mapping: toPublic(mapping) });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireAdmin(locals);
	if (!deleteModelMapping(getDb(), params.id)) error(404, { message: 'Mapping not found' });
	return json({ ok: true });
};
