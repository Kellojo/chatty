import { NON_PRIVATE } from '$lib/server/privacy/policy.js';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db/index.js';
import { findRoleModel } from '$lib/server/db/repo/models.js';
import { createProxyRequest, finalizeProxyRequest } from '$lib/server/db/repo/proxy-requests.js';
import { ModelUnavailableError, resolveRefTargets } from '$lib/server/llm/mapped.js';
import {
	MAX_SPEECH_INPUT,
	SpeechError,
	synthesizeWithFallbacks
} from '$lib/server/speech/synthesizer.js';
import { acquireSpeechSlot } from '$lib/server/speech/limiter.js';
import { relayUpstreamError } from '$lib/server/speech/targets.js';
import type { RequestHandler } from './$types';

const bodySchema = z.object({
	text: z.string().trim().min(1).max(MAX_SPEECH_INPUT),
	/** Reads with this voice instead of the configured one, e.g. to preview it. */
	voice: z.string().trim().min(1).max(100).optional()
});

/**
 * Speech requests each user may have running (each until its audio has fully
 * arrived). The chat reads one chunk ahead, so it needs two; more means many
 * replies are being read at once.
 */
const MAX_IN_FLIGHT = 3;

/** Reads text aloud with the Text to speech default (Settings → Defaults). */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, { message: 'Unauthorized' });
	const userId = locals.user.id;

	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Invalid request body' });

	const db = getDb();
	const roleModel = findRoleModel(db, 'text-to-speech');
	if (!roleModel) error(409, { message: 'No text to speech model is set' });

	const release = acquireSpeechSlot(`user:${userId}`, MAX_IN_FLIGHT);
	if (!release) error(429, { message: 'Too many speech requests at once' });

	// Logged with the other model calls (Usage → Requests), one row per read-aloud chunk.
	const log = createProxyRequest(db, {
		userId,
		source: 'chat',
		purpose: 'speech',
		endpoint: 'audio.speech',
		requestedModel: roleModel.model_id,
		stream: false
	});
	const startedAt = Date.now();
	let mappingId: string | null = null;

	let result: Awaited<ReturnType<typeof synthesizeWithFallbacks>>;
	try {
		const resolved = resolveRefTargets(
			{ providerId: roleModel.provider_id, modelId: roleModel.model_id },
			db
		);
		mappingId = resolved.mappingId;
		// Stopping playback aborts the request, which frees the slot and the provider call.
		result = await synthesizeWithFallbacks(parsed.data.text, resolved.targets, NON_PRIVATE, {
			voice: parsed.data.voice,
			signal: request.signal
		});
		finalizeProxyRequest(db, log.id, {
			status: 'complete',
			httpStatus: 200,
			latencyMs: Date.now() - startedAt,
			mappingId,
			providerId: result.target.providerId,
			modelId: result.target.modelId,
			fallbackIndex: result.index
		});
	} catch (e) {
		const local = e instanceof ModelUnavailableError;
		const { status, message } = local
			? { status: 409, message: e.message }
			: relayUpstreamError(
					e instanceof SpeechError ? e.status : 502,
					request.signal.aborted ? 'Cancelled' : e instanceof Error ? e.message : 'Speech failed'
				);
		finalizeProxyRequest(db, log.id, {
			status: 'failed',
			httpStatus: status,
			latencyMs: Date.now() - startedAt,
			mappingId,
			error: message
		});
		error(status, { message });
	} finally {
		release();
	}
	return new Response(result.audio, {
		headers: { 'content-type': result.contentType, 'cache-control': 'no-store' }
	});
};
