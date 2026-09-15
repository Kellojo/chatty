import { randomUUID } from 'node:crypto';
import {
	jsonSchema,
	tool,
	extractJsonMiddleware,
	wrapLanguageModel,
	type ImagePart,
	type LanguageModel,
	type LanguageModelMiddleware,
	type LanguageModelUsage,
	type ModelMessage,
	type TextPart,
	type TextStreamPart,
	type Tool,
	type ToolCallPart,
	type ToolChoice,
	type ToolResultPart
} from 'ai';
import { z } from 'zod';

const contentPartSchema = z.looseObject({
	type: z.string(),
	text: z.string().optional(),
	image_url: z.looseObject({ url: z.string() }).optional()
});

const messageSchema = z.object({
	role: z.enum(['system', 'user', 'assistant', 'tool']),
	content: z.union([z.string(), z.array(contentPartSchema), z.null()]).optional(),
	name: z.string().optional(),
	tool_calls: z
		.array(
			z.object({
				id: z.string(),
				type: z.literal('function'),
				function: z.object({ name: z.string(), arguments: z.string() })
			})
		)
		.optional(),
	tool_call_id: z.string().optional()
});

export const chatCompletionsSchema = z.object({
	model: z.string().min(1),
	messages: z.array(messageSchema).min(1),
	stream: z.boolean().optional().default(false),
	stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
	temperature: z.number().optional(),
	top_p: z.number().optional(),
	max_tokens: z.number().int().positive().optional(),
	stop: z.union([z.string(), z.array(z.string())]).optional(),
	tools: z
		.array(
			z.object({
				type: z.literal('function'),
				function: z.object({
					name: z.string(),
					description: z.string().optional(),
					parameters: z.record(z.string(), z.unknown()).optional()
				})
			})
		)
		.optional(),
	tool_choice: z
		.union([
			z.enum(['auto', 'none', 'required']),
			z.object({
				type: z.literal('function'),
				function: z.object({ name: z.string() })
			})
		])
		.optional(),
	response_format: z
		.union([
			z.object({ type: z.literal('text') }),
			z.object({ type: z.literal('json_object') }),
			z.object({
				type: z.literal('json_schema'),
				json_schema: z.object({ name: z.string(), schema: z.record(z.string(), z.unknown()) })
			})
		])
		.optional()
});

export type ChatCompletionsRequest = z.infer<typeof chatCompletionsSchema>;
type ChatMessage = ChatCompletionsRequest['messages'][number];

export type OpenAiErrorType =
	| 'authentication_error'
	| 'permission_error'
	| 'invalid_request_error'
	| 'not_found_error'
	| 'server_error';

export function openAiErrorObject(message: string, type: OpenAiErrorType) {
	return { error: { message, type, param: null, code: null } };
}

export function openAiError(status: number, message: string, type: OpenAiErrorType): Response {
	return new Response(JSON.stringify(openAiErrorObject(message, type)), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function textContent(content: ChatMessage['content']): string {
	if (typeof content === 'string') return content;
	if (!content) return '';
	return content
		.filter((part) => part.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text!)
		.join('');
}

export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
	const toolNames = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== 'assistant') continue;
		for (const call of message.tool_calls ?? []) {
			toolNames.set(call.id, call.function.name);
		}
	}
	return messages.map((message): ModelMessage => {
		switch (message.role) {
			case 'system':
				return { role: 'system', content: textContent(message.content) };
			case 'user': {
				if (!Array.isArray(message.content)) {
					return { role: 'user', content: textContent(message.content) };
				}
				const parts: (TextPart | ImagePart)[] = [];
				for (const part of message.content) {
					if (part.type === 'text' && typeof part.text === 'string') {
						parts.push({ type: 'text', text: part.text });
					} else if (part.type === 'image_url' && part.image_url?.url) {
						parts.push({ type: 'image', image: part.image_url.url });
					}
				}
				return { role: 'user', content: parts };
			}
			case 'assistant': {
				const text = textContent(message.content);
				const calls = message.tool_calls ?? [];
				if (calls.length === 0) return { role: 'assistant', content: text };
				const parts: (TextPart | ToolCallPart)[] = [];
				if (text) parts.push({ type: 'text', text });
				for (const call of calls) {
					let input: unknown;
					try {
						input = JSON.parse(call.function.arguments);
					} catch {
						input = {};
					}
					parts.push({
						type: 'tool-call',
						toolCallId: call.id,
						toolName: call.function.name,
						input
					});
				}
				return { role: 'assistant', content: parts };
			}
			case 'tool': {
				const toolCallId = message.tool_call_id ?? '';
				const result: ToolResultPart = {
					type: 'tool-result',
					toolCallId,
					toolName: toolNames.get(toolCallId) ?? 'unknown',
					output: { type: 'text', value: textContent(message.content) }
				};
				return { role: 'tool', content: [result] };
			}
		}
	});
}

type JsonSchemaInput = Parameters<typeof jsonSchema>[0];

export function toSdkTools(
	tools: ChatCompletionsRequest['tools']
): Record<string, Tool> | undefined {
	if (!tools?.length) return undefined;
	return Object.fromEntries(
		tools.map((t) => [
			t.function.name,
			tool({
				description: t.function.description,
				inputSchema: jsonSchema(
					(t.function.parameters ?? {
						type: 'object',
						properties: {}
					}) as unknown as JsonSchemaInput
				)
			})
		])
	);
}

export function toSdkToolChoice(
	choice: ChatCompletionsRequest['tool_choice']
): ToolChoice<Record<string, Tool>> | undefined {
	if (!choice) return undefined;
	if (typeof choice === 'string') return choice;
	return { type: 'tool', toolName: choice.function.name };
}

export type ResponseFormat = ChatCompletionsRequest['response_format'];

function responseFormatMiddleware(format: NonNullable<ResponseFormat>): LanguageModelMiddleware {
	return {
		specificationVersion: 'v4',
		transformParams: async ({ params }) => {
			if (format.type === 'json_object') {
				return { ...params, responseFormat: { type: 'json' } } as typeof params;
			}
			if (format.type === 'json_schema') {
				return {
					...params,
					responseFormat: {
						type: 'json',
						schema: format.json_schema.schema as Record<string, unknown>,
						name: format.json_schema.name
					}
				} as typeof params;
			}
			return params;
		}
	};
}

export function wrapModelForResponseFormat(
	model: LanguageModel,
	format: NonNullable<ResponseFormat>
): LanguageModel {
	return wrapLanguageModel({
		model: model as Parameters<typeof wrapLanguageModel>[0]['model'],
		middleware: [responseFormatMiddleware(format), extractJsonMiddleware()]
	}) as unknown as LanguageModel;
}

export interface OpenAiUsage {
	prompt_tokens: number | null;
	completion_tokens: number | null;
	total_tokens: number | null;
}

export interface OpenAiToolCallDelta {
	index: number;
	id?: string;
	type?: 'function';
	function?: { name?: string; arguments?: string };
}

export interface OpenAiChunk {
	id: string;
	object: 'chat.completion.chunk';
	created: number;
	model: string;
	choices: {
		index: number;
		delta: { role?: 'assistant'; content?: string; tool_calls?: OpenAiToolCallDelta[] };
		finish_reason: string | null;
	}[];
	usage?: OpenAiUsage;
}

export function mapFinishReason(reason: string): string {
	switch (reason) {
		case 'stop':
		case 'length':
			return reason;
		case 'tool-calls':
			return 'tool_calls';
		case 'content-filter':
			return 'content_filter';
		default:
			return 'stop';
	}
}

function toUsage(usage: LanguageModelUsage | null | undefined): OpenAiUsage {
	return {
		prompt_tokens: usage?.inputTokens ?? null,
		completion_tokens: usage?.outputTokens ?? null,
		total_tokens: usage?.totalTokens ?? null
	};
}

export function createChunker(model: string) {
	const id = `chatcmpl-${randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);
	const toolIndexes = new Map<string, number>();
	const base = () => ({ id, object: 'chat.completion.chunk' as const, created, model });
	return {
		roleChunk(): OpenAiChunk {
			return {
				...base(),
				choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
			};
		},
		part(part: TextStreamPart<Record<string, Tool>>): OpenAiChunk | null {
			switch (part.type) {
				case 'text-delta':
					return {
						...base(),
						choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }]
					};
				case 'tool-input-start': {
					let index = toolIndexes.get(part.id);
					if (index === undefined) {
						index = toolIndexes.size;
						toolIndexes.set(part.id, index);
					}
					return {
						...base(),
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index,
											id: part.id,
											type: 'function',
											function: { name: part.toolName, arguments: '' }
										}
									]
								},
								finish_reason: null
							}
						]
					};
				}
				case 'tool-input-delta': {
					const index = toolIndexes.get(part.id) ?? 0;
					return {
						...base(),
						choices: [
							{
								index: 0,
								delta: { tool_calls: [{ index, function: { arguments: part.delta } }] },
								finish_reason: null
							}
						]
					};
				}
				case 'finish':
					return {
						...base(),
						choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(part.finishReason) }]
					};
				default:
					return null;
			}
		},
		usage(usage: LanguageModelUsage | null | undefined): OpenAiChunk {
			return { ...base(), choices: [], usage: toUsage(usage) };
		}
	};
}

export function createAssembler() {
	let text = '';
	const toolCalls: { id: string; name: string; arguments: string }[] = [];
	const byId = new Map<string, { id: string; name: string; arguments: string }>();
	let finishReason: string | null = null;
	let usage: LanguageModelUsage | null = null;
	return {
		add(part: TextStreamPart<Record<string, Tool>>): void {
			switch (part.type) {
				case 'text-delta':
					text += part.text;
					break;
				case 'tool-input-start': {
					const entry = { id: part.id, name: part.toolName, arguments: '' };
					toolCalls.push(entry);
					byId.set(part.id, entry);
					break;
				}
				case 'tool-input-delta': {
					const entry = byId.get(part.id);
					if (entry) entry.arguments += part.delta;
					break;
				}
				case 'tool-call': {
					const input = JSON.stringify(part.input);
					const existing = byId.get(part.toolCallId);
					if (existing) {
						if (!existing.arguments) existing.arguments = input;
					} else {
						const entry = { id: part.toolCallId, name: part.toolName, arguments: input };
						toolCalls.push(entry);
						byId.set(part.toolCallId, entry);
					}
					break;
				}
				case 'finish':
					finishReason = mapFinishReason(part.finishReason);
					usage = part.totalUsage;
					break;
			}
		},
		get usage(): LanguageModelUsage | null {
			return usage;
		},
		build(model: string) {
			return {
				id: `chatcmpl-${randomUUID()}`,
				object: 'chat.completion' as const,
				created: Math.floor(Date.now() / 1000),
				model,
				choices: [
					{
						index: 0,
						message: {
							role: 'assistant' as const,
							content: text || null,
							...(toolCalls.length
								? {
										tool_calls: toolCalls.map((tc) => ({
											id: tc.id,
											type: 'function' as const,
											function: { name: tc.name, arguments: tc.arguments }
										}))
									}
								: {})
						},
						finish_reason: finishReason ?? 'stop'
					}
				],
				usage: toUsage(usage)
			};
		}
	};
}
