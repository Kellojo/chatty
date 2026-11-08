import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

let behavior: 'ok' | 'fail-first' | 'always-error' = 'ok';
const resolvedRefs: { providerId: string; modelId: string }[] = [];
let capturedOptions: unknown;
const defaultInputUsage = {
	total: 1,
	noCache: undefined as number | undefined,
	cacheRead: undefined as number | undefined,
	cacheWrite: undefined as number | undefined
};
let inputUsage = defaultInputUsage;

vi.mock('$lib/server/llm/registry.js', async () => {
	const { MockLanguageModelV3 } = await import('ai/test');
	const { simulateReadableStream } = await import('ai');
	class ModelUnavailableError extends Error {}
	const errWithStatus = (statusCode: number) =>
		Object.assign(new Error(`upstream ${statusCode}`), { statusCode });
	const model = new MockLanguageModelV3({
		doStream: async (options) => {
			capturedOptions = options;
			if (behavior === 'always-error') throw errWithStatus(500);
			return {
				stream: simulateReadableStream({
					chunks: [
						{ type: 'text-start', id: 't1' },
						{ type: 'text-delta', id: 't1', delta: 'Hi ' },
						{ type: 'text-delta', id: 't1', delta: 'there' },
						{ type: 'text-end', id: 't1' },
						{
							type: 'finish',
							finishReason: 'stop',
							usage: {
								inputTokens: inputUsage,
								outputTokens: { total: 2, text: undefined, reasoning: undefined }
							}
						} as never
					]
				})
			};
		}
	});
	return {
		resolveModel: (ref: { providerId: string; modelId: string }) => {
			resolvedRefs.push(ref);
			if (behavior === 'fail-first' && resolvedRefs.length === 1) {
				throw new ModelUnavailableError('model down');
			}
			return model;
		},
		ModelUnavailableError
	};
});

const { getDb, closeDb } = await import('../db/index.js');
const { createApiKey } = await import('../db/repo/api-keys.js');
const { createModelMapping } = await import('../db/repo/model-mappings.js');
const { listProxyRequests } = await import('../db/repo/proxy-requests.js');
const { createProvider } = await import('../db/repo/providers.js');
const { createModel, updateModel } = await import('../db/repo/models.js');
const { POST } = await import('../../../routes/api/v1/chat/completions/+server.js');
const { GET: GET_MODELS } = await import('../../../routes/api/v1/models/+server.js');

interface ErrorEnvelope {
	error: { message: string; type: string; param: null; code: null };
}

interface ChatCompletionResponse {
	object: string;
	choices: {
		index: number;
		message: { role: string; content: string | null };
		finish_reason: string;
	}[];
	usage: {
		prompt_tokens: number | null;
		completion_tokens: number | null;
		total_tokens: number | null;
	};
}

interface ModelsResponse {
	object: string;
	data: { id: string; object: string; created: number; owned_by: string }[];
}

interface CallInit {
	body?: unknown;
	headers?: Record<string, string>;
	method?: string;
	url?: string;
}

async function callResponse(
	handler: (event: never) => Response | Promise<Response>,
	init: CallInit = {}
): Promise<Response> {
	const url = new URL(init.url ?? 'http://localhost/api/v1/chat/completions');
	const headers = new Headers(init.headers);
	let body: string | undefined;
	if (init.body !== undefined) {
		headers.set('content-type', 'application/json');
		body = JSON.stringify(init.body);
	}
	const event = {
		locals: { user: null, session: null } as unknown as App.Locals,
		params: {},
		request: new Request(url, {
			method: init.method ?? (body !== undefined ? 'POST' : 'GET'),
			headers,
			body
		}),
		url
	};
	try {
		return await handler(event as never);
	} catch (e) {
		if (isHttpError(e)) {
			return new Response(JSON.stringify(e.body), {
				status: e.status,
				headers: { 'content-type': 'application/json' }
			});
		}
		throw e;
	}
}

async function call<T = unknown>(
	handler: (event: never) => Response | Promise<Response>,
	init: CallInit = {}
): Promise<{ status: number; body: T }> {
	const res = await callResponse(handler, init);
	return { status: res.status, body: (await res.json()) as T };
}

let rawKey: string;
let providerId: string;
let providerId2: string;

function auth(): Record<string, string> {
	return { authorization: `Bearer ${rawKey}` };
}

const chatBody = (model: string, extra: Record<string, unknown> = {}) => ({
	model,
	messages: [{ role: 'user', content: 'hi' }],
	...extra
});

beforeEach(async () => {
	closeDb();
	const db = getDb();
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES ('u1','a@b.c','A',0,0,0,'user')`
	).run();
	providerId = createProvider(db, { name: 'P', type: 'anthropic' }).id;
	createModel(db, { providerId, modelId: 'm1' });
	providerId2 = createProvider(db, { name: 'Q', type: 'anthropic' }).id;
	createModel(db, { providerId: providerId2, modelId: 'm2' });
	rawKey = (await createApiKey(db, { userId: 'u1', label: 'k', scopes: ['llm:invoke'] })).rawKey;
	behavior = 'ok';
	resolvedRefs.length = 0;
	capturedOptions = undefined;
	inputUsage = defaultInputUsage;
});

describe('GET /api/v1/models', () => {
	it('is public and lists enabled models and mappings', async () => {
		const db = getDb();
		createModelMapping(db, { name: 'fast', targets: [{ providerId, modelId: 'm1' }] });
		createModel(db, { providerId, modelId: 'disabled-model', enabled: false });

		const res = await call<ModelsResponse>(GET_MODELS, {
			url: 'http://localhost/api/v1/models'
		});
		expect(res.status).toBe(200);
		expect(res.body.object).toBe('list');
		expect(res.body.data).toContainEqual({
			id: 'm1',
			object: 'model',
			created: 0,
			owned_by: 'P',
			context_length: null
		});
		expect(res.body.data).toContainEqual({
			id: 'fast',
			object: 'model',
			created: 0,
			owned_by: 'ai-chat',
			context_length: null
		});
		expect(res.body.data.map((m) => m.id)).not.toContain('disabled-model');
	});
});

describe('POST /api/v1/chat/completions auth', () => {
	it('rejects requests without a valid key or scope', async () => {
		const noAuth = await call<ErrorEnvelope>(POST, { body: chatBody('m1') });
		expect(noAuth.status).toBe(401);
		expect(noAuth.body.error.type).toBe('authentication_error');

		const garbage = await call<ErrorEnvelope>(POST, {
			headers: { authorization: 'Bearer garbage' },
			body: chatBody('m1')
		});
		expect(garbage.status).toBe(401);
		expect(garbage.body.error.type).toBe('authentication_error');

		const noScope = (await createApiKey(getDb(), { userId: 'u1', label: 'k2', scopes: [] })).rawKey;
		const forbidden = await call<ErrorEnvelope>(POST, {
			headers: { authorization: `Bearer ${noScope}` },
			body: chatBody('m1')
		});
		expect(forbidden.status).toBe(403);
		expect(forbidden.body.error.type).toBe('permission_error');
	});

	it('rejects an invalid body with 400', async () => {
		const res = await call<ErrorEnvelope>(POST, {
			headers: auth(),
			body: { model: 'm1' }
		});
		expect(res.status).toBe(400);
		expect(res.body.error.type).toBe('invalid_request_error');
	});

	it('returns 404 for an unknown model', async () => {
		const res = await call<ErrorEnvelope>(POST, {
			headers: auth(),
			body: chatBody('no-such-model')
		});
		expect(res.status).toBe(404);
		expect(res.body.error.type).toBe('not_found_error');
	});
});

describe('POST /api/v1/chat/completions', () => {
	it('serves a non-streaming completion and logs usage', async () => {
		const res = await call<ChatCompletionResponse>(POST, {
			headers: auth(),
			body: chatBody('m1')
		});
		expect(res.status).toBe(200);
		expect(res.body.object).toBe('chat.completion');
		expect(res.body.choices[0].message.content).toBe('Hi there');
		expect(res.body.choices[0].finish_reason).toBe('stop');
		expect(res.body.usage.prompt_tokens).toBe(1);
		expect(res.body.usage.completion_tokens).toBe(2);
		expect(res.body.usage.total_tokens).toBe(3);

		const { rows, total } = listProxyRequests(getDb(), {});
		expect(total).toBe(1);
		const row = rows[0];
		expect(row.status).toBe('complete');
		expect(row.endpoint).toBe('chat.completions');
		expect(row.requested_model).toBe('m1');
		expect(row.input_tokens).toBe(1);
		expect(row.output_tokens).toBe(2);
		expect(row.provider_id).toBe(providerId);
		expect(row.model_id).toBe('m1');
		expect(row.latency_ms).not.toBeNull();
		expect(row.http_status).toBe(200);
		expect(row.stream).toBe(0);
	});

	it('records cached input tokens and prices them separately', async () => {
		const db = getDb();
		const model = createModel(db, { providerId, modelId: 'cached' });
		updateModel(db, model.id, {
			priceInput: 10,
			priceOutput: 20,
			priceCacheRead: 1,
			priceCacheWrite: 12.5
		});
		inputUsage = { total: 1000, noCache: 100, cacheRead: 800, cacheWrite: 100 };
		for (const stream of [false, true]) {
			const res = await callResponse(POST, {
				headers: auth(),
				body: chatBody('cached', { stream })
			});
			await res.text();
		}
		const rows = listProxyRequests(db, {}).rows;
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.input_tokens).toBe(1000);
			expect(row.cache_read_tokens).toBe(800);
			expect(row.cache_write_tokens).toBe(100);
			// (100*10 + 800*1 + 100*12.5 + 2*20) / 1M
			expect(row.cost_usd).toBeCloseTo(3090 / 1_000_000, 12);
		}
	});

	it('streams SSE chunks with usage and finalizes the log row', async () => {
		const res = await callResponse(POST, {
			headers: auth(),
			body: chatBody('m1', { stream: true, stream_options: { include_usage: true } })
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/event-stream');
		const text = await res.text();
		expect(text).toContain('"delta":{"role":"assistant"}');
		expect(text).toContain('"delta":{"content":"Hi "}');
		expect(text).toContain('"delta":{"content":"there"}');
		expect(text).toContain('"finish_reason":"stop"');
		expect(text).toContain('"prompt_tokens":1');
		expect(text).toContain('"completion_tokens":2');
		expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);

		const row = listProxyRequests(getDb(), {}).rows[0];
		expect(row.status).toBe('complete');
		expect(row.stream).toBe(1);
		expect(row.input_tokens).toBe(1);
		expect(row.output_tokens).toBe(2);
	});

	it('falls back to the next mapping target when the first is unavailable', async () => {
		const mapping = createModelMapping(getDb(), {
			name: 'fast',
			targets: [
				{ providerId, modelId: 'm1' },
				{ providerId: providerId2, modelId: 'm2' }
			]
		});
		behavior = 'fail-first';

		const res = await call<ChatCompletionResponse>(POST, {
			headers: auth(),
			body: chatBody('fast')
		});
		expect(res.status).toBe(200);
		expect(res.body.choices[0].message.content).toBe('Hi there');
		expect(resolvedRefs).toEqual([
			{ providerId, modelId: 'm1' },
			{ providerId: providerId2, modelId: 'm2' }
		]);

		const row = listProxyRequests(getDb(), {}).rows[0];
		expect(row.status).toBe('complete');
		expect(row.fallback_index).toBe(1);
		expect(row.mapping_id).toBe(mapping.id);
		expect(row.provider_id).toBe(providerId2);
		expect(row.model_id).toBe('m2');
	});

	it('returns 502 when every target fails', async () => {
		createModelMapping(getDb(), {
			name: 'fast',
			targets: [
				{ providerId, modelId: 'm1' },
				{ providerId: providerId2, modelId: 'm2' }
			]
		});
		behavior = 'always-error';

		const res = await call<ErrorEnvelope>(POST, {
			headers: auth(),
			body: chatBody('fast')
		});
		expect(res.status).toBe(502);
		expect(res.body.error.type).toBe('server_error');
		expect(res.body.error.message).toContain('upstream 500');

		const row = listProxyRequests(getDb(), {}).rows[0];
		expect(row.status).toBe('failed');
		expect(row.error).toContain('upstream 500');
		expect(row.fallback_index).toBe(0);
	});

	it('passes tools and tool call history through to the model', async () => {
		const res = await call<ChatCompletionResponse>(POST, {
			headers: auth(),
			body: {
				model: 'm1',
				messages: [
					{ role: 'user', content: 'weather?' },
					{
						role: 'assistant',
						content: '',
						tool_calls: [
							{
								id: 'call_1',
								type: 'function',
								function: { name: 'get_weather', arguments: '{"city":"Paris"}' }
							}
						]
					},
					{ role: 'tool', tool_call_id: 'call_1', content: 'sunny' }
				],
				tools: [
					{
						type: 'function',
						function: {
							name: 'get_weather',
							description: 'Get weather',
							parameters: { type: 'object', properties: { city: { type: 'string' } } }
						}
					}
				],
				tool_choice: 'auto'
			}
		});
		expect(res.status).toBe(200);

		const options = capturedOptions as {
			prompt: { role: string; content: unknown }[];
			tools: { type: string; name: string; inputSchema: unknown }[];
			toolChoice: unknown;
		};
		const assistant = options.prompt.find((m) => m.role === 'assistant')!;
		expect(assistant.content).toContainEqual(
			expect.objectContaining({
				type: 'tool-call',
				toolCallId: 'call_1',
				toolName: 'get_weather',
				input: { city: 'Paris' }
			})
		);
		const toolMessage = options.prompt.find((m) => m.role === 'tool')!;
		expect(toolMessage.content).toContainEqual(
			expect.objectContaining({
				type: 'tool-result',
				toolCallId: 'call_1',
				toolName: 'get_weather',
				output: expect.objectContaining({ type: 'text', value: 'sunny' })
			})
		);
		expect(options.tools).toContainEqual(
			expect.objectContaining({
				type: 'function',
				name: 'get_weather',
				inputSchema: { type: 'object', properties: { city: { type: 'string' } } }
			})
		);
		expect(options.toolChoice).toEqual({ type: 'auto' });
	});
});
