import { json, error } from '@sveltejs/kit';
import { agentPatchSchema, prepareAgentUpdate } from '$lib/server/agentInput.js';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb, type Db } from '$lib/server/db/index.js';
import {
	deleteAgent,
	getAgent,
	listAgentOverrides,
	setAgentOverride,
	toPublic,
	toPublicWithOverrides,
	updateAgent,
	type AgentRow
} from '$lib/server/db/repo/agents.js';
import type { RequestHandler } from './$types';

function visibleAgent(db: Db, userId: string, id: string): AgentRow {
	const agent = getAgent(db, id);
	if (!agent || (agent.user_id !== userId && agent.user_id !== null)) {
		error(404, { message: 'Agent not found' });
	}
	return agent;
}

function mutableAgent(db: Db, userId: string, id: string): AgentRow {
	const agent = visibleAgent(db, userId, id);
	if (agent.user_id !== userId) {
		error(403, { message: 'Built-in agents cannot be modified' });
	}
	return agent;
}

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const agent = visibleAgent(db, user.id, params.id);
	return json({ agent: toPublicWithOverrides(agent, listAgentOverrides(db, user.id)) });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const parsed = agentPatchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const db = getDb();
	const agent = visibleAgent(db, user.id, params.id);
	const data = parsed.data;

	if (agent.user_id === null) {
		if (data.enabled === undefined || Object.keys(data).some((key) => key !== 'enabled')) {
			error(403, { message: 'Built-in agents cannot be modified' });
		}
		setAgentOverride(db, user.id, agent.id, data.enabled);
		return json({ agent: toPublicWithOverrides(agent, listAgentOverrides(db, user.id)) });
	}

	const prepared = prepareAgentUpdate(db, agent, data);
	if (!prepared.ok) error(400, { message: prepared.error });
	const updated = updateAgent(db, agent.id, prepared.value);
	return json({ agent: toPublic(updated!) });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const agent = mutableAgent(db, user.id, params.id);
	deleteAgent(db, agent.id);
	return json({ ok: true });
};
