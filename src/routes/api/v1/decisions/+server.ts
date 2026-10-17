import { resolveApiKeyIdentity } from '$lib/server/auth/apiKey.js';
import { getDb } from '$lib/server/db/index.js';
import { createProxyRequest, finalizeProxyRequest } from '$lib/server/db/repo/proxy-requests.js';
import {
	decisionsRequestSchema,
	DecisionsError,
	forwardDecisions
} from '$lib/server/decisions/handler.js';
import { resolveTargets } from '$lib/server/proxy/handler.js';
import { ModelUnavailableError } from '$lib/server/llm/mapped.js';
import type { RequestHandler } from './$types';

function openAiError(status: number, message: string, type: string): Response {
	return new Response(JSON.stringify({ error: { message, type, code: status } }), {
		status,
		headers: { 'content-type': 'application/json' }
	});
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

	const parsed = decisionsRequestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return openAiError(
			400,
			parsed.error.issues[0]?.message ?? 'Invalid request body',
			'invalid_request_error'
		);
	}
	const input = parsed.data;

	const resolved = resolveTargets(db, input.model);
	if (!resolved) {
		return openAiError(404, `The model '${input.model}' does not exist`, 'not_found_error');
	}

	const log = createProxyRequest(db, {
		userId: identity.userId,
		apiKeyId: identity.keyId,
		endpoint: 'decisions',
		requestedModel: input.model,
		stream: false,
		source: 'proxy'
	});
	const startedAt = Date.now();

	try {
		const response = await forwardDecisions(input);

		finalizeProxyRequest(db, log.id, {
			status: 'complete',
			httpStatus: response.status,
			latencyMs: Date.now() - startedAt,
			mappingId: resolved.mappingId
		});

		return response;
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Decisions request failed';
		const isModelError = e instanceof ModelUnavailableError;
		const status = e instanceof DecisionsError ? e.status : isModelError ? 404 : 502;
		const type = isModelError ? 'not_found_error' : 'server_error';
		finalizeProxyRequest(db, log.id, {
			status: 'failed',
			httpStatus: status,
			latencyMs: Date.now() - startedAt,
			error: message
		});
		return openAiError(status, `Upstream error: ${message}`, type);
	}
};
