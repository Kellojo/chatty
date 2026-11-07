import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { MAX_HISTORY_IMPORT } from '$lib/coding-environments.js';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	getCodingEnvironment,
	type CodingEnvironmentRow
} from '$lib/server/db/repo/coding-environments.js';
import { T3ClientError } from '$lib/server/t3/client.js';
import { importHistoryThreads, listHistoryThreads } from '$lib/server/t3/history.js';
import type { RequestHandler } from './$types';

function enabledEnvironment(userId: string, id: string): CodingEnvironmentRow {
	const env = getCodingEnvironment(getDb(), userId, id);
	if (!env) error(404, { message: 'Environment not found' });
	if (env.enabled !== 1) error(409, { message: 'Enable the environment to import sessions' });
	return env;
}

async function remote<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (e) {
		if (e instanceof T3ClientError) error(502, { message: e.message });
		error(502, { message: 'Could not reach the coding environment' });
	}
}

/** Past T3 Code threads of the environment that aren't in Chatty yet. */
export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const env = enabledEnvironment(user.id, params.id);
	return json({ threads: await remote(() => listHistoryThreads(getDb(), env)) });
};

const importSchema = z.object({
	threadIds: z.array(z.string().min(1).max(200)).min(1).max(MAX_HISTORY_IMPORT)
});

/** Imports the chosen past threads as coding conversations. */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const parsed = importSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const env = enabledEnvironment(user.id, params.id);
	const imported = await remote(() => importHistoryThreads(getDb(), env, parsed.data.threadIds));
	return json({ imported: imported.length });
};
