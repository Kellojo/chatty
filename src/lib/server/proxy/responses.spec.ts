import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

let behavior: 'ok' | 'always-error' = 'ok';
let capturedOptions: unknown;

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
			// The AI SDK rejects responses that ignore a forced tool choice, so honour it.
			const forcedTool = options.toolChoice?.type === 'tool' ? options.toolChoice.toolName : null;
			return {
				stream: simulateReadableStream({
					chunks: [
						...(forcedTool
							? [
									{
										type: 'tool-call',
										toolCallId: 'c1',
										toolName: forcedTool,
										input: '{}'
									} as const
								]
							: ([
									{ type: 'text-start', id: 't1' },
									{ type: 'text-delta', id: 't1', delta: 'Hi ' },
									{ type: 'text-delta', id: 't1', delta: 'there' },
									{ type: 'text-end', id: 't1' }
								] as const)),
						{
							type: 'finish',
							finishReason: forcedTool ? 'tool-calls' : 'stop',
							usage: {
								inputTokens: {
									total: 1,
									noCache: undefined,
									cacheRead: undefined,
									cacheWrite: undefined
								},
								outputTokens: { total: 2, text: undefined, reasoning: undefined }
							}
						} as never
					]
				})
			};
		}
	});
	return {
		resolveModel: () => model,
		ModelUnavailableError
	};
});

const { getDb, closeDb } = await import('../db/index.js');
const { createApiKey } = await import('../db/repo/api-keys.js');
const { listProxyRequests } = await import('../db/repo/proxy-requests.js');
const { createProvider } = await import('../db/repo/providers.js');
const { createModel } = await import('../db/repo/models.js');
const { POST } = await import('../../../routes/api/v1/responses/+server.js');

interface ErrorEnvelope {
	error: { message: string; type: string; param: null; code: null };
}

interface ResponsesApiResponse {
	id: string;
	object: string;
	created_at: number;
	status: string;
	model: string;
	output: {
		id: string;
		type: string;
		status: string;
		role?: string;
		content?: { type: string; text: string }[];
		call_id?: string;
		name?: string;
		arguments?: string;
	}[];
	usage: { input_tokens: number | null; output_tokens: number | null; total_tokens: number | null };
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
	const url = new URL(init.url ?? 'http://localhost/api/v1/responses');
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

function auth(): Record<string, string> {
	return { authorization: `Bearer ${rawKey}` };
}

beforeEach(async () => {
	closeDb();
	const db = getDb();
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES ('u1','a@b.c','A',0,0,0,'user')`
	).run();
	providerId = createProvider(db, { name: 'P', type: 'anthropic' }).id;
	createModel(db, { providerId, modelId: 'm1' });
	rawKey = (await createApiKey(db, { userId: 'u1', label: 'k', scopes: ['llm:invoke'] })).rawKey;
	behavior = 'ok';
	capturedOptions = undefined;
});

describe('POST /api/v1/responses auth', () => {
	it('rejects requests without a valid key or scope', async () => {
		const noAuth = await call<ErrorEnvelope>(POST, { body: { model: 'm1', input: 'hi' } });
		expect(noAuth.status).toBe(401);
		expect(noAuth.body.error.type).toBe('authentication_error');

		const noScope = (await createApiKey(getDb(), { userId: 'u1', label: 'k2', scopes: [] })).rawKey;
		const forbidden = await call<ErrorEnvelope>(POST, {
			headers: { authorization: `Bearer ${noScope}` },
			body: { model: 'm1', input: 'hi' }
		});
		expect(forbidden.status).toBe(403);
		expect(forbidden.body.error.type).toBe('permission_error');
	});

	it('returns 404 for an unknown model', async () => {
		const res = await call<ErrorEnvelope>(POST, {
			headers: auth(),
			body: { model: 'no-such-model', input: 'hi' }
		});
		expect(res.status).toBe(404);
		expect(res.body.error.type).toBe('not_found_error');
	});
});

describe('POST /api/v1/responses', () => {
	it('serves a non-streaming response and logs usage', async () => {
		const res = await call<ResponsesApiResponse>(POST, {
			headers: auth(),
			body: { model: 'm1', input: 'hi' }
		});
		expect(res.status).toBe(200);
		expect(res.body.object).toBe('response');
		expect(res.body.status).toBe('completed');
		expect(res.body.output[0].type).toBe('message');
		expect(res.body.output[0].content?.[0]).toEqual({ type: 'output_text', text: 'Hi there' });
		expect(res.body.usage.input_tokens).toBe(1);
		expect(res.body.usage.output_tokens).toBe(2);
		expect(res.body.usage.total_tokens).toBe(3);

		const { rows, total } = listProxyRequests(getDb(), {});
		expect(total).toBe(1);
		const row = rows[0];
		expect(row.status).toBe('complete');
		expect(row.endpoint).toBe('responses');
		expect(row.requested_model).toBe('m1');
		expect(row.input_tokens).toBe(1);
		expect(row.output_tokens).toBe(2);
		expect(row.provider_id).toBe(providerId);
		expect(row.model_id).toBe('m1');
		expect(row.latency_ms).not.toBeNull();
		expect(row.http_status).toBe(200);
		expect(row.stream).toBe(0);
	});

	it('converts instructions and input items to the model prompt', async () => {
		const res = await call<ResponsesApiResponse>(POST, {
			headers: auth(),
			body: {
				model: 'm1',
				instructions: 'Be terse',
				input: [
					{ role: 'user', content: 'weather?' },
					{
						type: 'function_call',
						call_id: 'call_1',
						name: 'get_weather',
						arguments: '{"city":"Paris"}'
					},
					{ type: 'function_call_output', call_id: 'call_1', output: 'sunny' }
				]
			}
		});
		expect(res.status).toBe(200);

		const options = capturedOptions as { prompt: { role: string; content: unknown }[] };
		expect(options.prompt[0]).toEqual({ role: 'system', content: 'Be terse' });
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
	});

	it('streams response.* SSE events and finalizes the log row', async () => {
		const res = await callResponse(POST, {
			headers: auth(),
			body: { model: 'm1', input: 'hi', stream: true }
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/event-stream');
		const text = await res.text();
		expect(text).toContain('event: response.created');
		expect(text).toContain('event: response.output_text.delta');
		expect(text).toContain('"delta":"Hi "');
		expect(text).toContain('"delta":"there"');
		expect(text).toContain('event: response.completed');
		expect(text).toContain('"input_tokens":1');
		expect(text).toContain('"output_tokens":2');

		const row = listProxyRequests(getDb(), {}).rows[0];
		expect(row.status).toBe('complete');
		expect(row.endpoint).toBe('responses');
		expect(row.stream).toBe(1);
		expect(row.input_tokens).toBe(1);
		expect(row.output_tokens).toBe(2);
	});

	it('passes tools and tool_choice through to the model', async () => {
		const res = await call<ResponsesApiResponse>(POST, {
			headers: auth(),
			body: {
				model: 'm1',
				input: 'weather?',
				tools: [
					{
						type: 'function',
						name: 'get_weather',
						description: 'Get weather',
						parameters: { type: 'object', properties: { city: { type: 'string' } } }
					}
				],
				tool_choice: { type: 'function', name: 'get_weather' }
			}
		});
		expect(res.status).toBe(200);

		const options = capturedOptions as {
			tools: { type: string; name: string; inputSchema: unknown }[];
			toolChoice: unknown;
		};
		expect(options.tools).toContainEqual(
			expect.objectContaining({
				type: 'function',
				name: 'get_weather',
				inputSchema: { type: 'object', properties: { city: { type: 'string' } } }
			})
		);
		expect(options.toolChoice).toEqual({ type: 'tool', toolName: 'get_weather' });
	});

	it('returns 502 when the upstream fails', async () => {
		behavior = 'always-error';
		const res = await call<ErrorEnvelope>(POST, {
			headers: auth(),
			body: { model: 'm1', input: 'hi' }
		});
		expect(res.status).toBe(502);
		expect(res.body.error.type).toBe('server_error');
		expect(res.body.error.message).toContain('upstream 500');

		const row = listProxyRequests(getDb(), {}).rows[0];
		expect(row.status).toBe('failed');
		expect(row.error).toContain('upstream 500');
	});
});
