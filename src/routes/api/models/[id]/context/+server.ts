import { error, json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getModel } from '$lib/server/db/repo/models.js';
import { forgetLearnedContextLimit, learnedContextInfo } from '$lib/server/llm/contextLimit.js';
import { reportedContextLength } from '$lib/server/llm/lmstudio.js';
import type { RequestHandler } from './$types';

function refOf(id: string) {
	const model = getModel(getDb(), id);
	if (!model) error(404, { message: 'Model not found' });
	return { providerId: model.provider_id, modelId: model.model_id };
}

/** The context the model reports and the limit learned from overflow errors, if any. */
export const GET: RequestHandler = async ({ locals, params }) => {
	requireAdmin(locals);
	const ref = refOf(params.id);
	const reported = await reportedContextLength(ref);
	return json({ reported, learned: learnedContextInfo(ref, reported) });
};

/** Forgets the learned limit; the next overflow (if any) learns it again. */
export const DELETE: RequestHandler = ({ locals, params }) => {
	requireAdmin(locals);
	forgetLearnedContextLimit(refOf(params.id));
	return json({ ok: true });
};
