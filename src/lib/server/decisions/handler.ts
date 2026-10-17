import { z } from 'zod';
import { getDb } from '../db/index.js';
import { findModel } from '../db/repo/models.js';
import { getProvider } from '../db/repo/providers.js';
import { decryptSecret } from '../crypto.js';
import { ModelUnavailableError } from '../llm/mapped.js';
import { createLogger } from '../logger.js';
import { resolveTargets } from '../proxy/handler.js';

const log = createLogger('decisions');

export class DecisionsError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

// --- Zod schemas for the OpenAI Decisions API request ---

const inputTextPartSchema = z.object({
	type: z.literal('input_text'),
	text: z.string()
});

const inputImagePartSchema = z.object({
	type: z.literal('input_image'),
	image_url: z.string()
});

const inputPartSchema = z.discriminatedUnion('type', [inputTextPartSchema, inputImagePartSchema]);

const inputMessageSchema = z.object({
	role: z.enum(['user', 'system', 'assistant', 'developer']),
	content: z.union([z.string(), z.array(inputPartSchema)])
});

const inputSchema = z.union([z.string(), z.array(inputMessageSchema)]);

const predicateQuestionSchema = z.object({
	type: z.literal('predicate'),
	name: z.string().min(1),
	instructions: z.string()
});

const choiceOptionSchema = z.object({
	value: z.string(),
	description: z.string().optional()
});

const choiceQuestionSchema = z.object({
	type: z.literal('choice'),
	name: z.string().min(1),
	instructions: z.string(),
	choices: z.array(choiceOptionSchema).min(1)
});

const scoreLevelSchema = z.object({
	label: z.string(),
	description: z.string().optional()
});

const scoreQuestionSchema = z.object({
	type: z.literal('score'),
	name: z.string().min(1),
	instructions: z.string(),
	levels: z.array(scoreLevelSchema).min(2)
});

const questionSchema = z.discriminatedUnion('type', [
	predicateQuestionSchema,
	choiceQuestionSchema,
	scoreQuestionSchema
]);

export const decisionsRequestSchema = z.object({
	model: z.string().min(1),
	input: inputSchema,
	questions: z.array(questionSchema).min(1).max(100)
});

export type DecisionsRequest = z.infer<typeof decisionsRequestSchema>;

/**
 * Forward a decisions request to the upstream provider.
 * Resolves the model (supports model mappings by name and direct model lookup),
 * checks the decisions capability, and proxies the request body to the
 * provider's /decisions endpoint.
 */
export async function forwardDecisions(request: DecisionsRequest): Promise<Response> {
	const db = getDb();

	const resolved = resolveTargets(db, request.model);
	if (!resolved) {
		throw new ModelUnavailableError(`No model found for decisions request "${request.model}"`);
	}

	let lastError: unknown = null;

	for (let i = 0; i < resolved.targets.length; i++) {
		const target = resolved.targets[i];
		const provider = getProvider(db, target.providerId);
		if (!provider || provider.enabled !== 1) {
			lastError = new ModelUnavailableError(`Provider ${target.providerId} is not available`);
			continue;
		}

		const model = findModel(db, target.providerId, target.modelId);
		if (!model || model.enabled !== 1) {
			lastError = new ModelUnavailableError(`Model ${target.modelId} is not available`);
			continue;
		}

		const caps = JSON.parse(model.capabilities) as string[];
		if (!caps.includes('decisions')) {
			lastError = new ModelUnavailableError(`Model ${target.modelId} does not support decisions`);
			continue;
		}

		if (provider.type === 'anthropic') {
			lastError = new ModelUnavailableError(
				`Provider "${provider.name}" does not expose a decisions API`
			);
			continue;
		}

		if (!provider.base_url) {
			lastError = new ModelUnavailableError(`Provider "${provider.name}" is missing a base URL`);
			continue;
		}

		const apiKey = provider.api_key_enc ? decryptSecret(provider.api_key_enc) : undefined;
		const baseUrl = provider.base_url.replace(/\/$/, '');

		try {
			const body = {
				model: target.modelId,
				input: request.input,
				questions: request.questions
			};

			const headers: Record<string, string> = {
				'content-type': 'application/json'
			};
			if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

			log.info('Decisions request', {
				providerId: target.providerId,
				modelId: target.modelId,
				baseUrl
			});

			const res = await fetch(`${baseUrl}/decisions`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body)
			});

			if (!res.ok) {
				const raw = await res.text().catch(() => 'Unknown error');
				let message = raw;
				try {
					const parsed = JSON.parse(raw) as { error?: { message?: string } };
					if (parsed.error?.message) message = parsed.error.message;
				} catch {
					/* not JSON, use raw text */
				}
				throw new DecisionsError(res.status, message);
			}

			return new Response(await res.text(), {
				status: res.status,
				headers: { 'content-type': 'application/json' }
			});
		} catch (e) {
			lastError = e;
			if (i < resolved.targets.length - 1) continue;
		}
	}

	if (lastError instanceof DecisionsError) throw lastError;
	throw new DecisionsError(
		502,
		lastError instanceof Error ? lastError.message : 'Decisions request failed'
	);
}
