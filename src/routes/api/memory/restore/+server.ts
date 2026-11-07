import fs from 'node:fs';
import path from 'node:path';
import { applyPatch, parsePatch, reversePatch } from 'diff';
import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin, requireUser } from '$lib/server/auth/guards.js';
import { parseFrontmatter } from '$lib/server/frontmatter.js';
import { getDb } from '$lib/server/db/index.js';
import { getMemoryWrite } from '$lib/server/db/repo/memory-writes.js';
import { writeConcept } from '$lib/server/memory/bundle.js';
import { normalizeConceptPath, resolveConceptAbs } from '$lib/server/memory/paths.js';
import type { RequestHandler } from './$types';

const restoreSchema = z.object({
	scope: z.enum(['user', 'shared']).optional(),
	path: z.string().min(1),
	writeId: z.string().min(1)
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = restoreSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const data = parsed.data;
	const scope = data.scope === 'shared' ? 'shared' : 'user';
	if (scope === 'shared') requireAdmin(locals);
	const relPath = normalizeConceptPath(data.path);
	if (!relPath) error(400, { message: `Invalid concept path: ${data.path}` });
	const db = getDb();
	const write = getMemoryWrite(db, data.writeId);
	const expectedPath = scope === 'shared' ? `shared/${relPath}` : relPath;
	if (
		!write ||
		write.concept_path !== expectedPath ||
		(scope === 'user' && write.user_id !== user.id)
	) {
		error(404, { message: 'Memory write not found' });
	}
	const abs = resolveConceptAbs(scope, user.id, relPath);
	let currentRaw = '';
	if (abs && fs.existsSync(abs)) {
		try {
			currentRaw = fs.readFileSync(abs, 'utf8');
		} catch {
			currentRaw = '';
		}
	}
	const [patch] = parsePatch(write.diff ?? '');
	if (!patch) error(409, { message: 'Cannot restore: no diff recorded for this write' });
	const restored = applyPatch(currentRaw, reversePatch(patch));
	if (restored === false) {
		error(409, { message: 'Cannot restore: current content conflicts with the recorded diff' });
	}
	const { data: fm, content } = parseFrontmatter(restored);
	try {
		const concept = writeConcept(
			db,
			scope,
			user.id,
			relPath,
			{
				frontmatter: {
					title:
						typeof fm.title === 'string' && fm.title.trim()
							? fm.title
							: path.basename(relPath, '.md'),
					type: typeof fm.type === 'string' ? fm.type : undefined,
					description: typeof fm.description === 'string' ? fm.description : undefined,
					tags: Array.isArray(fm.tags)
						? fm.tags.filter((t): t is string => typeof t === 'string')
						: undefined,
					timestamp: typeof fm.timestamp === 'string' ? fm.timestamp : undefined
				},
				body: content
			},
			{ author: `user:${user.id}`, userId: user.id }
		);
		return json({ concept });
	} catch (e) {
		error(400, { message: e instanceof Error ? e.message : 'Failed to restore concept' });
	}
};
