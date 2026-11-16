import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb, type Db } from '$lib/server/db/index.js';
import {
	createModelMapping,
	getModelMappingByName,
	listModelMappings,
	toPublic
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

const createSchema = z.object({
	name: nameSchema,
	targets: z.array(targetSchema).min(1).max(10),
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

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json({ mappings: listModelMappings(getDb()).map(toPublic) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const parsed = createSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const db = getDb();
	if (getModelMappingByName(db, parsed.data.name)) {
		error(400, { message: 'Name already in use' });
	}
	validateTargets(db, parsed.data.targets);
	const mapping = createModelMapping(db, parsed.data);
	return json({ mapping: toPublic(mapping) }, { status: 201 });
};
