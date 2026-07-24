import {
	streamText,
	type LanguageModel,
	type LanguageModelUsage,
	type ModelMessage,
	type TextStreamPart,
	type Tool,
	type ToolChoice
} from 'ai';
import type { ModelMappingTarget, ProxyCompression } from '$lib/types.js';
import { resolveApiKeyIdentity } from '../auth/apiKey.js';
import { getDb, type Db } from '../db/index.js';
import {
	getModelMappingByName,
	listEnabledModelMappings,
	parseTargets
} from '../db/repo/model-mappings.js';
import { findEnabledModelByModelId, findModel, listEnabledModels } from '../db/repo/models.js';
import { listProviders } from '../db/repo/providers.js';
import {
	createProxyRequest,
	finalizeProxyRequest,
	type FinalizeProxyRequestInput
} from '../db/repo/proxy-requests.js';
import { getUserSetting } from '../db/repo/user-settings.js';
import { ModelUnavailableError, resolveModel } from '../llm/registry.js';
import {
	applyCaveman,
	cavemanOverheadTokens,
	CAVEMAN_PROMPTS,
	estimateCavemanSaved,
	getCavemanBaseline,
	parseCavemanLevel,
	recordCavemanBaseline,
	type CavemanBaseline,
	type CavemanLevel
} from './caveman.js';
import {
	chatCompletionsSchema,
	createAssembler,
	createChunker,
	openAiError,
	openAiErrorObject,
	toModelMessages,
	toSdkToolChoice,
	toSdkTools
} from './openaiChat.js';
import {
	responsesFormats,
	responsesRequestSchema,
	toResponsesPrompt,
	toResponsesSdkToolChoice,
	toResponsesSdkTools
} from './openaiResponses.js';
import { computeCostUsd } from './pricing.js';

export interface OpenAiModelEntry {
	id: string;
	object: 'model';
	created: number;
	owned_by: string;
}

export function listOpenAiModels(db: Db): { object: 'list'; data: OpenAiModelEntry[] } {
	const providerNames = new Map(listProviders(db).map((p) => [p.id, p.name]));
	const models: OpenAiModelEntry[] = listEnabledModels(db).map((m) => ({
		id: m.model_id,
		object: 'model',
		created: 0,
		owned_by: providerNames.get(m.provider_id) ?? 'unknown'
	}));
	const mappings: OpenAiModelEntry[] = listEnabledModelMappings(db).map((m) => ({
		id: m.name,
		object: 'model',
		created: 0,
		owned_by: 'ai-chat'
	}));
	return { object: 'list', data: [...models, ...mappings] };
}

interface ResolvedModel {
	mappingId: string | null;
	targets: ModelMappingTarget[];
}

function resolveTargets(db: Db, model: string): ResolvedModel | null {
	const mapping = getModelMappingByName(db, model);
	if (mapping && mapping.enabled === 1) {
		const targets = parseTargets(mapping);
		if (targets.length > 0) return { mappingId: mapping.id, targets };
	}
	const row = findEnabledModelByModelId(db, model);
	if (!row) return null;
	return { mappingId: null, targets: [{ providerId: row.provider_id, modelId: row.model_id }] };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRetryable(error: unknown): boolean {
	if (error instanceof ModelUnavailableError) return true;
	if (error instanceof TypeError) return true;
	const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
	return (
		typeof statusCode === 'number' &&
		(statusCode === 408 ||
			statusCode === 409 ||
			statusCode === 425 ||
			statusCode === 429 ||
			statusCode >= 500)
	);
}

const CONTENTFUL_PARTS = new Set([
	'text-delta',
	'tool-input-start',
	'tool-input-delta',
	'tool-call',
	'finish'
]);

function isContentful(part: TextStreamPart<Record<string, Tool>>): boolean {
	return CONTENTFUL_PARTS.has(part.type);
}

export interface StreamOptions {
	temperature?: number;
	topP?: number;
	maxOutputTokens?: number;
	stopSequences?: string[];
}

interface PreparedRequest {
	instructions?: string;
	messages: ModelMessage[];
	tools: Record<string, Tool> | undefined;
	toolChoice: ToolChoice<Record<string, Tool>> | undefined;
	options: StreamOptions;
}

function startStream(prepared: PreparedRequest, model: LanguageModel, signal: AbortSignal) {
	return streamText({
		model,
		instructions: prepared.instructions,
		messages: prepared.messages,
		allowSystemInMessages: true,
		tools: prepared.tools,
		toolChoice: prepared.toolChoice,
		temperature: prepared.options.temperature,
		topP: prepared.options.topP,
		maxOutputTokens: prepared.options.maxOutputTokens,
		stopSequences: prepared.options.stopSequences,
		abortSignal: signal
	});
}

type CavemanMode = 'instructions' | 'messages';

interface CompressionContext {
	userId: string;
	cavemanLevel: CavemanLevel;
	baseline: CavemanBaseline | null;
}

async function prepareCompression(
	db: Db,
	userId: string,
	prepared: PreparedRequest,
	model: string,
	cavemanMode: CavemanMode
): Promise<CompressionContext> {
	const cavemanLevel = parseCavemanLevel(getUserSetting(db, userId, 'proxyCaveman'));
	let baseline: CavemanBaseline | null = null;
	if (cavemanLevel !== 'off') {
		baseline = getCavemanBaseline(db, userId);
		const cavemanContent = CAVEMAN_PROMPTS[cavemanLevel];
		let index = 0;
		while (index < prepared.messages.length && prepared.messages[index].role === 'system') {
			index++;
		}
		if (cavemanMode === 'instructions' || index >= prepared.messages.length) {
			prepared.instructions = applyCaveman(prepared.instructions, cavemanLevel);
		} else if (index > 0) {
			const firstSystemMsg = prepared.messages[0]!;
			firstSystemMsg.content = `${firstSystemMsg.content}\n\n${cavemanContent}`;
		} else if (index === 0 && prepared.instructions) {
			prepared.instructions = applyCaveman(prepared.instructions, cavemanLevel);
		} else {
			prepared.messages = [{ role: 'system', content: cavemanContent }, ...prepared.messages];
		}
	}
	return { userId, cavemanLevel, baseline };
}

function finalizeCompression(
	db: Db,
	ctx: CompressionContext,
	outputTokens: number | null
): ProxyCompression | null {
	try {
		let compression: ProxyCompression | null = null;
		if (ctx.cavemanLevel !== 'off') {
			const saved =
				outputTokens == null
					? { estSaved: null, basis: undefined }
					: estimateCavemanSaved(ctx.cavemanLevel, outputTokens, ctx.baseline);
			compression = {
				caveman: {
					level: ctx.cavemanLevel,
					estSaved: saved.estSaved,
					overhead: cavemanOverheadTokens(ctx.cavemanLevel),
					basis: saved.basis
				}
			};
		} else if (outputTokens != null) {
			recordCavemanBaseline(db, ctx.userId, outputTokens);
		}
		return compression;
	} catch {
		return null;
	}
}

export type SseEmit = (event: string | null, data: unknown) => void;

export interface ProxyAssembler {
	add(part: TextStreamPart<Record<string, Tool>>): void;
	readonly usage: LanguageModelUsage | null;
	build(): unknown;
}

export interface ProxyStreamFormat {
	start?(emit: SseEmit): void;
	part(part: TextStreamPart<Record<string, Tool>>, emit: SseEmit): void;
	finish(usage: LanguageModelUsage | null, emit: SseEmit): void;
	fail(message: string, emit: SseEmit): void;
	done(): string | null;
}

export interface ProxyFormats {
	assembler(): ProxyAssembler;
	stream(): ProxyStreamFormat;
}

function chatFormats(model: string, includeUsage: boolean): ProxyFormats {
	return {
		assembler: () => {
			const assembler = createAssembler();
			return {
				add: (part) => assembler.add(part),
				get usage() {
					return assembler.usage;
				},
				build: () => assembler.build(model)
			};
		},
		stream: () => {
			const chunker = createChunker(model);
			let sentRole = false;
			return {
				part(part, emit) {
					const chunk = chunker.part(part);
					if (!chunk) return;
					if (!sentRole) {
						emit(null, chunker.roleChunk());
						sentRole = true;
					}
					emit(null, chunk);
				},
				finish(usage, emit) {
					if (includeUsage) emit(null, chunker.usage(usage));
				},
				fail(message, emit) {
					emit(null, openAiErrorObject(`Upstream error: ${message}`, 'server_error'));
				},
				done: () => 'data: [DONE]\n\n'
			};
		}
	};
}

type Finalize = (patch: FinalizeProxyRequestInput) => void;

function servedCost(
	db: Db,
	target: ModelMappingTarget,
	usage: LanguageModelUsage | null
): number | null {
	// Prefer the actual cost from the provider if available (e.g., OpenRouter)
	const rawCost = usage?.raw?.cost;
	if (typeof rawCost === 'number' && Number.isFinite(rawCost)) {
		return rawCost;
	}
	// Fall back to calculating from stored pricing
	const row = findModel(db, target.providerId, target.modelId);
	return computeCostUsd(
		row?.price_input ?? null,
		row?.price_output ?? null,
		usage?.inputTokens,
		usage?.outputTokens
	);
}

async function respondNonStreaming(
	db: Db,
	prepared: PreparedRequest,
	resolved: ResolvedModel,
	request: Request,
	finalize: Finalize,
	startedAt: number,
	formats: ProxyFormats,
	compression: CompressionContext
): Promise<Response> {
	let lastError: unknown = null;
	for (let i = 0; i < resolved.targets.length; i++) {
		const target = resolved.targets[i];
		const assembler = formats.assembler();
		let contentful = false;
		try {
			const model = resolveModel(target);
			const result = startStream(prepared, model, request.signal);
			for await (const part of result.fullStream) {
				if (part.type === 'error') throw part.error;
				if (part.type === 'abort') throw new Error('Upstream aborted the request');
				if (!isContentful(part)) continue;
				contentful = true;
				assembler.add(part);
			}
			const usage = assembler.usage;
			finalize({
				status: 'complete',
				httpStatus: 200,
				latencyMs: Date.now() - startedAt,
				mappingId: resolved.mappingId,
				providerId: target.providerId,
				modelId: target.modelId,
				fallbackIndex: i,
				inputTokens: usage?.inputTokens ?? null,
				outputTokens: usage?.outputTokens ?? null,
				costUsd: servedCost(db, target, usage),
				compression: finalizeCompression(db, compression, usage?.outputTokens ?? null)
			});
			return new Response(JSON.stringify(assembler.build()), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		} catch (e) {
			lastError = e;
			if (!contentful && i < resolved.targets.length - 1 && isRetryable(e)) continue;
			break;
		}
	}
	finalize({
		status: 'failed',
		httpStatus: 502,
		latencyMs: Date.now() - startedAt,
		mappingId: resolved.mappingId,
		error: errorMessage(lastError)
	});
	return openAiError(502, `Upstream error: ${errorMessage(lastError)}`, 'server_error');
}

function respondStreaming(
	db: Db,
	prepared: PreparedRequest,
	resolved: ResolvedModel,
	request: Request,
	finalize: Finalize,
	startedAt: number,
	formats: ProxyFormats,
	compression: CompressionContext
): Response {
	const encoder = new TextEncoder();
	const abort = new AbortController();
	request.signal.addEventListener('abort', () => abort.abort());
	let finalized = false;
	const finalizeOnce: Finalize = (patch) => {
		if (finalized) return;
		finalized = true;
		finalize(patch);
	};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const format = formats.stream();
			const emit: SseEmit = (event, data) =>
				controller.enqueue(
					encoder.encode(
						`${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`
					)
				);
			const sendDone = () => {
				const frame = format.done();
				if (frame !== null) controller.enqueue(encoder.encode(frame));
			};
			const pump = async () => {
				format.start?.(emit);
				let served: {
					target: ModelMappingTarget;
					index: number;
					usage: LanguageModelUsage | null;
				} | null = null;
				let lastError: unknown = null;
				for (let i = 0; i < resolved.targets.length; i++) {
					const target = resolved.targets[i];
					let contentful = false;
					try {
						const model = resolveModel(target);
						const result = startStream(prepared, model, abort.signal);
						for await (const part of result.fullStream) {
							if (part.type === 'error') throw part.error;
							if (part.type === 'abort') {
								throw abort.signal.reason ?? new Error('Upstream aborted the request');
							}
							if (!isContentful(part)) continue;
							contentful = true;
							if (part.type === 'finish') {
								served = { target, index: i, usage: part.totalUsage };
							}
							format.part(part, emit);
						}
						if (served) break;
						throw new Error('Upstream ended the stream without finishing');
					} catch (e) {
						lastError = e;
						if (!contentful && i < resolved.targets.length - 1 && isRetryable(e)) continue;
						throw e;
					}
				}
				if (!served) throw lastError ?? new Error('Upstream produced no response');
				format.finish(served.usage, emit);
				sendDone();
				finalizeOnce({
					status: 'complete',
					httpStatus: 200,
					latencyMs: Date.now() - startedAt,
					mappingId: resolved.mappingId,
					providerId: served.target.providerId,
					modelId: served.target.modelId,
					fallbackIndex: served.index,
					inputTokens: served.usage?.inputTokens ?? null,
					outputTokens: served.usage?.outputTokens ?? null,
					costUsd: servedCost(db, served.target, served.usage),
					compression: finalizeCompression(db, compression, served.usage?.outputTokens ?? null)
				});
				controller.close();
			};
			pump().catch((e) => {
				const message = errorMessage(e);
				try {
					format.fail(message, emit);
					sendDone();
					finalizeOnce({
						status: 'failed',
						httpStatus: 200,
						latencyMs: Date.now() - startedAt,
						mappingId: resolved.mappingId,
						error: message
					});
					controller.close();
				} catch {
					finalizeOnce({
						status: 'failed',
						latencyMs: Date.now() - startedAt,
						mappingId: resolved.mappingId,
						error: message
					});
				}
			});
		},
		cancel() {
			abort.abort();
			finalizeOnce({
				status: 'failed',
				latencyMs: Date.now() - startedAt,
				mappingId: resolved.mappingId,
				error: 'Client disconnected'
			});
		}
	});
	return new Response(stream, {
		status: 200,
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
}

export async function handleChatCompletions(request: Request): Promise<Response> {
	const db = getDb();
	const identity = await resolveApiKeyIdentity(db, request.headers.get('authorization'));
	if (!identity) {
		return openAiError(401, 'Missing or invalid API key', 'authentication_error');
	}
	if (!identity.scopes.includes('llm:invoke')) {
		return openAiError(403, "API key is missing the 'llm:invoke' scope", 'permission_error');
	}
	const parsed = chatCompletionsSchema.safeParse(await request.json().catch(() => null));
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
		endpoint: 'chat.completions',
		requestedModel: input.model,
		stream: input.stream
	});
	const startedAt = Date.now();
	const finalize: Finalize = (patch) => {
		try {
			finalizeProxyRequest(db, log.id, patch);
		} catch {
			void 0;
		}
	};
	const prepared: PreparedRequest = {
		messages: toModelMessages(input.messages),
		tools: toSdkTools(input.tools),
		toolChoice: toSdkToolChoice(input.tool_choice),
		options: {
			temperature: input.temperature,
			topP: input.top_p,
			maxOutputTokens: input.max_tokens,
			stopSequences:
				input.stop === undefined ? undefined : Array.isArray(input.stop) ? input.stop : [input.stop]
		}
	};
	const compression = await prepareCompression(
		db,
		identity.userId,
		prepared,
		input.model,
		'messages'
	);
	const formats = chatFormats(input.model, input.stream_options?.include_usage ?? false);
	if (input.stream) {
		return respondStreaming(
			db,
			prepared,
			resolved,
			request,
			finalize,
			startedAt,
			formats,
			compression
		);
	}
	return respondNonStreaming(
		db,
		prepared,
		resolved,
		request,
		finalize,
		startedAt,
		formats,
		compression
	);
}

export async function handleResponses(request: Request): Promise<Response> {
	const db = getDb();
	const identity = await resolveApiKeyIdentity(db, request.headers.get('authorization'));
	if (!identity) {
		return openAiError(401, 'Missing or invalid API key', 'authentication_error');
	}
	if (!identity.scopes.includes('llm:invoke')) {
		return openAiError(403, "API key is missing the 'llm:invoke' scope", 'permission_error');
	}
	const parsed = responsesRequestSchema.safeParse(await request.json().catch(() => null));
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
		endpoint: 'responses',
		requestedModel: input.model,
		stream: input.stream
	});
	const startedAt = Date.now();
	const finalize: Finalize = (patch) => {
		try {
			finalizeProxyRequest(db, log.id, patch);
		} catch {
			void 0;
		}
	};
	const prompt = toResponsesPrompt(input);
	const prepared: PreparedRequest = {
		instructions: prompt.instructions,
		messages: prompt.messages,
		tools: toResponsesSdkTools(input.tools),
		toolChoice: toResponsesSdkToolChoice(input.tool_choice),
		options: {
			temperature: input.temperature,
			topP: input.top_p,
			maxOutputTokens: input.max_output_tokens
		}
	};
	const compression = await prepareCompression(
		db,
		identity.userId,
		prepared,
		input.model,
		'instructions'
	);
	const formats = responsesFormats(input.model);
	if (input.stream) {
		return respondStreaming(
			db,
			prepared,
			resolved,
			request,
			finalize,
			startedAt,
			formats,
			compression
		);
	}
	return respondNonStreaming(
		db,
		prepared,
		resolved,
		request,
		finalize,
		startedAt,
		formats,
		compression
	);
}
