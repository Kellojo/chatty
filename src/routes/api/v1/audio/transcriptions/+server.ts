import { resolveApiKeyIdentity } from '$lib/server/auth/apiKey.js';
import { getDb } from '$lib/server/db/index.js';
import { getModelMappingByName, parseTargets } from '$lib/server/db/repo/model-mappings.js';
import { findEnabledModelByModelId } from '$lib/server/db/repo/models.js';
import { createProxyRequest, finalizeProxyRequest } from '$lib/server/db/repo/proxy-requests.js';
import { transcribeAudio, TranscriptionError } from '$lib/server/speech/transcriber.js';
import type { ModelMappingTarget } from '$lib/types.js';
import type { RequestHandler } from './$types';

function openAiError(status: number, message: string, type: string): Response {
	return new Response(JSON.stringify({ error: { message, type, code: status } }), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

interface ResolvedModel {
	mappingId: string | null;
	targets: ModelMappingTarget[];
}

function resolveTargets(db: ReturnType<typeof getDb>, model: string): ResolvedModel | null {
	const mapping = getModelMappingByName(db, model);
	if (mapping && mapping.enabled === 1) {
		const targets = parseTargets(mapping);
		if (targets.length > 0) return { mappingId: mapping.id, targets };
	}
	const row = findEnabledModelByModelId(db, model);
	if (!row) return null;
	return {
		mappingId: null,
		targets: [{ providerId: row.provider_id, modelId: row.model_id }]
	};
}

export const POST: RequestHandler = async ({ request }) => {
	const db = getDb();
	const identity = await resolveApiKeyIdentity(db, request.headers.get('authorization'));
	if (!identity) {
		return openAiError(401, 'Missing or invalid API key', 'authentication_error');
	}
	if (!identity.scopes.includes('llm:invoke')) {
		return openAiError(403, "API key is missing the 'llm:invoke' scope", 'permission_error');
	}

	let formData: FormData;
	try {
		formData = await request.formData();
	} catch {
		return openAiError(400, 'Request body must be multipart/form-data', 'invalid_request_error');
	}

	const audioFile = formData.get('file');
	const modelName = formData.get('model');
	const language = formData.get('language');
	const prompt = formData.get('prompt');
	const responseFormat = formData.get('response_format');
	const temperatureRaw = formData.get('temperature');

	if (!audioFile || !(audioFile instanceof File)) {
		return openAiError(400, 'Missing audio file (field: "file")', 'invalid_request_error');
	}
	if (typeof modelName !== 'string' || !modelName.trim()) {
		return openAiError(400, 'Missing model parameter', 'invalid_request_error');
	}

	const resolved = resolveTargets(db, modelName);
	if (!resolved) {
		return openAiError(404, `The model '${modelName}' does not exist`, 'not_found_error');
	}

	const log = createProxyRequest(db, {
		userId: identity.userId,
		apiKeyId: identity.keyId,
		endpoint: 'audio.transcriptions',
		requestedModel: modelName,
		stream: false,
		source: 'proxy'
	});
	const startedAt = Date.now();

	try {
		const buffer = await audioFile.arrayBuffer();
		const result = await transcribeAudio(
			buffer,
			resolved.targets[0].providerId,
			resolved.targets[0].modelId,
			{
				language: typeof language === 'string' && language ? language : undefined,
				prompt: typeof prompt === 'string' && prompt ? prompt : undefined,
				responseFormat:
					typeof responseFormat === 'string'
						? (responseFormat as 'json' | 'text' | 'srt' | 'vtt' | 'verbose_json')
						: 'json',
				temperature: typeof temperatureRaw === 'string' ? parseFloat(temperatureRaw) : undefined
			}
		);

		finalizeProxyRequest(db, log.id, {
			status: 'complete',
			httpStatus: 200,
			latencyMs: Date.now() - startedAt,
			mappingId: resolved.mappingId,
			providerId: resolved.targets[0].providerId,
			modelId: resolved.targets[0].modelId,
			fallbackIndex: 0
		});

		if (typeof result === 'string') {
			return new Response(result, {
				status: 200,
				headers: { 'content-type': 'text/plain' }
			});
		}

		return new Response(JSON.stringify(result), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Transcription failed';
		const status = e instanceof TranscriptionError ? e.status : 502;
		finalizeProxyRequest(db, log.id, {
			status: 'failed',
			httpStatus: status,
			latencyMs: Date.now() - startedAt,
			mappingId: resolved.mappingId,
			error: message
		});
		return openAiError(status, `Upstream error: ${message}`, 'server_error');
	}
};
