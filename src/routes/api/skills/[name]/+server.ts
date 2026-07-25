import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin, requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { listSkillInvocations } from '$lib/server/db/repo/skill-invocations.js';
import { publishServerEvent } from '$lib/server/events/bus.js';
import { readSkill } from '$lib/server/skills/scanner.js';
import { deleteSkill, duplicateSkill, writeSkill } from '$lib/server/skills/store.js';
import type { SkillScope } from '$lib/server/skills/paths.js';
import type { RequestHandler } from './$types';

function scopeFrom(url: URL): SkillScope {
	return url.searchParams.get('scope') === 'shared' ? 'shared' : 'user';
}

export const GET: RequestHandler = ({ locals, params, url }) => {
	const user = requireUser(locals);
	const scope = scopeFrom(url);
	const skill = readSkill(scope, user.id, params.name);
	if (!skill) error(404, { message: 'Skill not found' });
	const invocations = listSkillInvocations(getDb(), {
		userId: user.id,
		skillName: skill.name,
		limit: 50
	});
	return json({ skill, invocations });
};

const putSchema = z.object({
	title: z.string().min(1).max(120).optional(),
	description: z.string().min(1).max(500).optional(),
	triggers: z
		.array(
			z.object({
				keyword: z.string().min(1).max(100).optional(),
				intent: z.string().min(1).max(200).optional()
			})
		)
		.max(20)
		.optional(),
	when: z.string().max(500).nullable().optional(),
	tools: z.array(z.string().min(1).max(100)).max(50).optional(),
	enabled: z.boolean().optional(),
	version: z.string().max(50).nullable().optional(),
	author: z.string().max(120).nullable().optional(),
	body: z.string().optional()
});

export const PUT: RequestHandler = async ({ locals, params, url, request }) => {
	const user = requireUser(locals);
	const scope = scopeFrom(url);
	if (scope === 'shared') requireAdmin(locals);
	const existing = readSkill(scope, user.id, params.name);
	if (!existing) error(404, { message: 'Skill not found' });
	const parsed = putSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	try {
		const skill = writeSkill(scope, user.id, {
			name: existing.name,
			title: parsed.data.title ?? existing.title,
			description: parsed.data.description ?? existing.description,
			triggers: parsed.data.triggers,
			when: parsed.data.when === undefined ? existing.frontmatter.when : parsed.data.when,
			tools: parsed.data.tools,
			enabled: parsed.data.enabled,
			version: parsed.data.version === undefined ? existing.version : parsed.data.version,
			author: parsed.data.author === undefined ? existing.author : parsed.data.author,
			body: parsed.data.body ?? existing.body
		});
		publishServerEvent(user.id, { type: 'skills.changed' });
		publishServerEvent(user.id, { type: 'skill.updated', name: skill.name, scope });
		return json({ skill });
	} catch (e) {
		error(400, { message: e instanceof Error ? e.message : 'Failed to update skill' });
	}
};

export const DELETE: RequestHandler = ({ locals, params, url }) => {
	const user = requireUser(locals);
	const scope = scopeFrom(url);
	if (scope === 'shared') requireAdmin(locals);
	if (!deleteSkill(scope, user.id, params.name)) error(404, { message: 'Skill not found' });
	publishServerEvent(user.id, { type: 'skills.changed' });
	publishServerEvent(user.id, { type: 'skill.deleted', name: params.name, scope });
	return json({ ok: true });
};

const postSchema = z.object({ action: z.literal('duplicate'), newName: z.string().min(1).max(64) });

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const parsed = postSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Invalid body' });
	try {
		const skill = duplicateSkill(user.id, params.name, parsed.data.newName);
		publishServerEvent(user.id, { type: 'skills.changed' });
		return json({ skill }, { status: 201 });
	} catch (e) {
		error(400, { message: e instanceof Error ? e.message : 'Failed to duplicate skill' });
	}
};
