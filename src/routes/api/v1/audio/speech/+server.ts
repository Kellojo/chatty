import { z } from 'zod';
import { resolveApiKeyIdentity } from '$lib/server/auth/apiKey.js';
import { getDb } from '$lib/server/db/index.js';
import { createProxyRequest, finalizeProxyRequest } from '$lib/server/db/repo/proxy-requests.js';
import { resolveTargets } from '$lib/server/proxy/handler.js';
import { acquireSpeechSlot } from '$lib/server/speech/limiter.js';
import { relayUpstreamError } from '$lib/server/speech/targets.js';
import {
	MAX_SPEECH_INPUT,
	SPEECH_FORMATS,
	SpeechError,
	synthesizeWithFallbacks
} from '$lib/server/speech/synthesizer.js';
import type { RequestHandler } from './$types';

function openAiError(status: number, message: string, type: string): Response {
	return new Response(JSON.stringify({ error: { message, type, code: status } }), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

const bodySchema = z.object({
	model: z.string().trim().min(1),
	input: z.string().min(1).max(MAX_SPEECH_INPUT),
	voice: z.string().max(100).optional(),
	response_format: z.enum(SPEECH_FORMATS).optional(),
	speed: z.number().min(0.25).max(4).optional(),
	instructions: z.string().max(MAX_SPEECH_INPUT).optional()
});

/** Speech requests one API key may have running at once. */
const MAX_IN_FLIGHT_PER_KEY = 4;

/** OpenAI-compatible text to speech: returns the audio bytes. */
export const POST: RequestHandler = async ({ request }) => {
	const db = getDb();
	const identity = await resolveApiKeyIdentity(db, request.headers.get('authorization'));
	if (!identity) {
		return openAiError(401, 'Missing or invalid API key', 'authentication_error');
	}
	if (!identity.scopes.includes('llm:invoke')) {
		return openAiError(403, "API key is missing the 'llm:invoke' scope", 'permission_error');
	}

	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const message = issue
			? `${issue.path.join('.') || 'body'}: ${issue.message}`
			: 'Invalid request body';
		return openAiError(400, message, 'invalid_request_error');
	}
	const body = parsed.data;

	const resolved = resolveTargets(db, body.model);
	if (!resolved) {
		return openAiError(404, `The model '${body.model}' does not exist`, 'not_found_error');
	}

	const release = acquireSpeechSlot(`key:${identity.keyId}`, MAX_IN_FLIGHT_PER_KEY);
	if (!release) {
		return openAiError(429, 'Too many speech requests at once for this key', 'rate_limit_error');
	}

	const log = createProxyRequest(db, {
		userId: identity.userId,
		apiKeyId: identity.keyId,
		endpoint: 'audio.speech',
		requestedModel: body.model,
		stream: false,
		source: 'proxy',
		purpose: 'speech'
	});
	const startedAt = Date.now();

	try {
		const { audio, contentType, index, target } = await synthesizeWithFallbacks(
			body.input,
			resolved.targets,
			resolved.privacy,
			{
				voice: body.voice,
				responseFormat: body.response_format,
				speed: body.speed,
				instructions: body.instructions,
				signal: request.signal
			}
		);

		finalizeProxyRequest(db, log.id, {
			status: 'complete',
			httpStatus: 200,
			latencyMs: Date.now() - startedAt,
			mappingId: resolved.mappingId,
			providerId: target.providerId,
			modelId: target.modelId,
			fallbackIndex: index
		});

		return new Response(audio, { status: 200, headers: { 'content-type': contentType } });
	} catch (e) {
		const local = e instanceof SpeechError && !e.upstream;
		const { status, message } = relayUpstreamError(
			e instanceof SpeechError ? e.status : 502,
			e instanceof Error ? e.message : 'Speech failed'
		);
		finalizeProxyRequest(db, log.id, {
			status: 'failed',
			httpStatus: status,
			latencyMs: Date.now() - startedAt,
			mappingId: resolved.mappingId,
			error: message
		});
		if (local) return openAiError(status, message, 'invalid_request_error');
		return openAiError(status, `Upstream error: ${message}`, 'server_error');
	} finally {
		release();
	}
};
