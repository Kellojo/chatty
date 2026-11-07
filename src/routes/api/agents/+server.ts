import { json, error } from '@sveltejs/kit';
import { agentCreateSchema, prepareAgentCreate } from '$lib/server/agentInput.js';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	createAgent,
	listAgentOverrides,
	listAgents,
	listPersonaAgents,
	toPublic,
	toPublicWithOverrides
} from '$lib/server/db/repo/agents.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	const db = getDb();
	const rows =
		url.searchParams.get('trigger') === 'persona'
			? listPersonaAgents(db, user.id)
			: listAgents(db, user.id);
	const overrides = listAgentOverrides(db, user.id);
	return json({ agents: rows.map((row) => toPublicWithOverrides(row, overrides)) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = agentCreateSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const db = getDb();
	const prepared = prepareAgentCreate(db, parsed.data);
	if (!prepared.ok) error(400, { message: prepared.error });
	const agent = createAgent(db, user.id, prepared.value);
	return json({ agent: toPublic(agent) }, { status: 201 });
};
