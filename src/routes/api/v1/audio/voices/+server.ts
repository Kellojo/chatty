import { json } from '@sveltejs/kit';
import { resolveApiKeyIdentity } from '$lib/server/auth/apiKey.js';
import { getDb } from '$lib/server/db/index.js';
import { resolveTargets } from '$lib/server/proxy/handler.js';
import { listVoices } from '$lib/server/speech/voices.js';
import type { RequestHandler } from './$types';

function openAiError(status: number, message: string, type: string): Response {
	return json({ error: { message, type, code: status } }, { status });
}

/**
 * The voices a text-to-speech model accepts, for `/v1/audio/speech`'s `voice`.
 * Same shape as Kokoro-FastAPI's endpoint; `voices` is empty when the provider
 * doesn't list them (any name may then work). For a mapping, its primary target's.
 */
export const GET: RequestHandler = async ({ request, url }) => {
	const db = getDb();
	const identity = await resolveApiKeyIdentity(db, request.headers.get('authorization'));
	if (!identity) return openAiError(401, 'Missing or invalid API key', 'authentication_error');
	if (!identity.scopes.includes('llm:invoke')) {
		return openAiError(403, "API key is missing the 'llm:invoke' scope", 'permission_error');
	}

	const model = url.searchParams.get('model')?.trim();
	if (!model) return openAiError(400, 'Missing model parameter', 'invalid_request_error');
	const resolved = resolveTargets(db, model);
	if (!resolved) return openAiError(404, `The model '${model}' does not exist`, 'not_found_error');

	const list = await listVoices(db, resolved.targets[0]);
	return json({
		voices: (list?.voices ?? []).map((id) => ({ id, name: id })),
		default_voice: list?.defaultVoice ?? null
	});
};
