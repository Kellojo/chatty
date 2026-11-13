import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { startAgentRun } from '$lib/server/agents/runner.js';
import { resolveApiKeyIdentity } from '$lib/server/auth/apiKey.js';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { toPublic } from '$lib/server/db/repo/agent-runs.js';
import { getAgent, type AgentRow } from '$lib/server/db/repo/agents.js';
import { MAX_LAUNCH_PROMPT } from '$lib/server/t3/tasks.js';
import type { RequestHandler } from './$types';

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
let nextSweepAt = 0;

/** Exported (underscore = not a route export) for tests. */
export const _rateBuckets = rateBuckets;

export function _checkRateLimit(key: string, now = Date.now()): boolean {
	// Drop expired buckets at most once per window so the map stays bounded
	// by the keys active in the last window.
	if (now >= nextSweepAt) {
		for (const [k, b] of rateBuckets) if (b.resetAt <= now) rateBuckets.delete(k);
		nextSweepAt = now + RATE_WINDOW_MS;
	}
	let bucket = rateBuckets.get(key);
	if (!bucket || bucket.resetAt <= now) {
		bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
		rateBuckets.set(key, bucket);
	}
	bucket.count++;
	return bucket.count <= RATE_LIMIT;
}

const bodySchema = z.object({
	instructions: z.string().max(MAX_LAUNCH_PROMPT).optional()
});

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const db = getDb();
	const authorization = request.headers.get('authorization');
	let agent: AgentRow;
	let trigger: 'http' | 'manual';
	let runUserId: string;
	let rateKey: string;
	let apiKeyId: string | undefined;

	if (authorization) {
		const identity = await resolveApiKeyIdentity(db, authorization);
		if (!identity) error(401, { message: 'Invalid API key' });
		if (!identity.scopes.includes('agents:run')) {
			error(403, { message: 'Missing agents:run scope' });
		}
		const found = getAgent(db, params.id);
		if (!found || found.user_id !== identity.userId) error(404, { message: 'Agent not found' });
		agent = found;
		trigger = 'http';
		runUserId = identity.userId;
		rateKey = `key:${identity.keyId}`;
		apiKeyId = identity.keyId;
	} else {
		const user = requireUser(locals);
		const found = getAgent(db, params.id);
		if (!found) error(404, { message: 'Agent not found' });
		if (found.user_id === user.id) {
			agent = found;
			trigger = 'manual';
			runUserId = user.id;
		} else if (found.user_id === null) {
			if ((user as { role?: string }).role !== 'admin') {
				error(403, { message: 'Admin required' });
			}
			if (found.enabled === 1) {
				return json(
					{
						ignored: true,
						message: 'Built-in agent runs on its schedule; manual run ignored while enabled.'
					},
					{ status: 202 }
				);
			}
			agent = found;
			trigger = 'manual';
			runUserId = user.id;
		} else {
			error(404, { message: 'Agent not found' });
		}
		rateKey = `user:${user.id}`;
	}

	if (!_checkRateLimit(rateKey)) error(429, { message: 'Rate limit exceeded' });

	const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	// An API key may start a coding agent, but only with the task it was saved
	// with: free-form instructions would let any key holder run arbitrary work
	// in the user's repositories.
	if (trigger === 'http' && agent.coding_target && parsed.data.instructions?.trim()) {
		error(400, { message: 'Coding agents run their saved task; instructions are not accepted' });
	}

	try {
		const { run, done } = await startAgentRun({
			agentId: agent.id,
			trigger,
			userId: runUserId,
			instructions: parsed.data.instructions,
			apiKeyId
		});
		done.catch(() => undefined);
		return json({ run: toPublic(run) }, { status: 202 });
	} catch (e) {
		error(400, { message: e instanceof Error ? e.message : 'Failed to start agent run' });
	}
};
