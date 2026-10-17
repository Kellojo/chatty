import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionsRequest } from './handler.js';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

// --- upstream fetch mock ---
let upstreamBehavior: 'ok' | 'down' | 'not-found' = 'ok';
const upstreamRequests: { url: string; body: unknown }[] = [];

vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input.toString();
	let body: unknown = null;
	try {
		body = init?.body ? JSON.parse(init.body as string) : null;
	} catch {
		/* not JSON */
	}
	upstreamRequests.push({ url, body });

	if (upstreamBehavior === 'down') {
		return new Response('Service Unavailable', { status: 503 });
	}
	if (upstreamBehavior === 'not-found') {
		return new Response(JSON.stringify({ error: { message: 'Not found' } }), {
			status: 404,
			headers: { 'content-type': 'application/json' }
		});
	}
	return new Response(
		JSON.stringify({
			answers: [{ type: 'choice', name: 'department', choice: 'billing', confidence: 0.93 }]
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);
});

const { getDb, closeDb } = await import('../db/index.js');
const { createApiKey } = await import('../db/repo/api-keys.js');
const { createModelMapping } = await import('../db/repo/model-mappings.js');
const { listProxyRequests } = await import('../db/repo/proxy-requests.js');
const { createProvider } = await import('../db/repo/providers.js');
const { createModel } = await import('../db/repo/models.js');
const { decisionsRequestSchema, DecisionsError } =
	await import('./handler.js');

// Save real forwardDecisions for handler unit tests via importActual, then
// mock the module so endpoint tests don't need a real upstream.
const handlerModule = await vi.importActual<typeof import('./handler.js')>('./handler.js');
const realForward = handlerModule.forwardDecisions;

vi.mock('./handler.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./handler.js')>();
	return {
		...actual,
		forwardDecisions: vi.fn()
	};
});
const { forwardDecisions: mockedForward } = await import('./handler.js');

const { POST } = await import('../../../routes/api/v1/decisions/+server.js');

// --- test helpers ---
interface ErrorEnvelope {
	error: { message: string; type: string; code: number };
}

interface DecisionsAnswer {
	type: string;
	name: string;
	choice?: string;
	confidence?: number;
}

interface DecisionsResponse {
	answers: DecisionsAnswer[];
}

interface CallInit {
	body?: unknown;
	headers?: Record<string, string>;
}

async function callResponse(init: CallInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	let body: string | undefined;
	if (init.body !== undefined) {
		headers.set('content-type', 'application/json');
		body = JSON.stringify(init.body);
	}
	const event = {
		locals: {} as App.Locals,
		params: {},
		request: new Request('http://localhost/api/v1/decisions', {
			method: 'POST',
			headers,
			body
		}),
		url: new URL('http://localhost/api/v1/decisions')
	};
	return POST(event as never);
}

async function call<T = unknown>(init: CallInit = {}): Promise<{ status: number; body: T }> {
	const res = await callResponse(init);
	return { status: res.status, body: (await res.json()) as T };
}

let rawKey: string;
let providerId: string;

function auth(): Record<string, string> {
	return { authorization: `Bearer ${rawKey}` };
}

const decisionsBody = (model: string, extra: Partial<DecisionsRequest> = {}): DecisionsRequest => ({
	model,
	input: 'Check this',
	questions: [
		{ type: 'predicate', name: 'is_ok', instructions: 'Is it ok?' }
	],
	...extra
});

beforeEach(async () => {
	closeDb();
	const db = getDb();
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES ('u1','a@b.c','A',0,0,0,'user')`
	).run();
	providerId = createProvider(db, {
		name: 'P',
		type: 'openai-compatible',
		baseUrl: 'http://provider.example/v1'
	}).id;
	createModel(db, { providerId, modelId: 'j1', capabilities: ['chat', 'streaming', 'decisions'] });
	rawKey = (await createApiKey(db, { userId: 'u1', label: 'k', scopes: ['llm:invoke'] })).rawKey;
	upstreamBehavior = 'ok';
	upstreamRequests.length = 0;
	vi.mocked(mockedForward).mockReset();
});

// --- schema validation ---
describe('decisionsRequestSchema', () => {
	it('validates a minimal predicate request', () => {
		const parsed = decisionsRequestSchema.safeParse({
			model: 'j1',
			input: 'hello',
			questions: [{ type: 'predicate', name: 'q1', instructions: 'Is it?' }]
		});
		expect(parsed.success).toBe(true);
	});

	it('validates a request with string input and choice question', () => {
		const parsed = decisionsRequestSchema.safeParse({
			model: 'j1',
			input: 'I was charged twice',
			questions: [
				{
					type: 'choice',
					name: 'dept',
					instructions: 'Which department?',
					choices: [
						{ value: 'billing', description: 'Payments' },
						{ value: 'support' }
					]
				}
			]
		});
		expect(parsed.success).toBe(true);
	});

	it('validates a request with message array input and score question', () => {
		const parsed = decisionsRequestSchema.safeParse({
			model: 'j1',
			input: [{ role: 'user', content: 'Severity check' }],
			questions: [
				{
					type: 'score',
					name: 'severity',
					instructions: 'How severe?',
					levels: [
						{ label: 'Low' },
						{ label: 'Medium' },
						{ label: 'High' }
					]
				}
			]
		});
		expect(parsed.success).toBe(true);
	});

	it('validates a request with multiple questions', () => {
		const parsed = decisionsRequestSchema.safeParse({
			model: 'j1',
			input: 'multi',
			questions: [
				{ type: 'predicate', name: 'p1', instructions: 'Check' },
				{
					type: 'choice',
					name: 'c1',
					instructions: 'Pick',
					choices: [{ value: 'a' }, { value: 'b' }]
				},
				{
					type: 'score',
					name: 's1',
					instructions: 'Rate',
					levels: [{ label: 'Bad' }, { label: 'Good' }]
				}
			]
		});
		expect(parsed.success).toBe(true);
	});

	it('validates input with image parts', () => {
		const parsed = decisionsRequestSchema.safeParse({
			model: 'j1',
			input: [
				{
					role: 'user',
					content: [
						{ type: 'input_text', text: 'Inspect' },
						{ type: 'input_image', image_url: 'data:image/png;base64,abc' }
					]
				}
			],
			questions: [{ type: 'predicate', name: 'damage', instructions: 'Visible damage?' }]
		});
		expect(parsed.success).toBe(true);
	});

	it('rejects missing model', () => {
		const parsed = decisionsRequestSchema.safeParse({
			input: 'hi',
			questions: [{ type: 'predicate', name: 'q1', instructions: 'Is it?' }]
		});
		expect(parsed.success).toBe(false);
	});

	it('rejects empty questions array', () => {
		const parsed = decisionsRequestSchema.safeParse({
			model: 'j1',
			input: 'hi',
			questions: []
		});
		expect(parsed.success).toBe(false);
	});

	it('rejects invalid question type', () => {
		const parsed = decisionsRequestSchema.safeParse({
			model: 'j1',
			input: 'hi',
			questions: [{ type: 'unknown', name: 'q1' }]
		});
		expect(parsed.success).toBe(false);
	});

	it('rejects choice question without choices', () => {
		const parsed = decisionsRequestSchema.safeParse({
			model: 'j1',
			input: 'hi',
			questions: [
				{ type: 'choice', name: 'q1', instructions: 'Pick one' }
			]
		});
		expect(parsed.success).toBe(false);
	});

	it('rejects score question with fewer than 2 levels', () => {
		const parsed = decisionsRequestSchema.safeParse({
			model: 'j1',
			input: 'hi',
			questions: [
				{
					type: 'score',
					name: 'q1',
					instructions: 'Rate',
					levels: [{ label: 'Only' }]
				}
			]
		});
		expect(parsed.success).toBe(false);
	});
});

// --- handler: forwardDecisions ---
describe('forwardDecisions', () => {
	it('proxies a valid request and returns the upstream response', async () => {
		const response = await realForward(decisionsBody('j1'));
		expect(response.status).toBe(200);

		const body = (await response.json()) as DecisionsResponse;
		expect(body.answers[0].type).toBe('choice');
		expect(body.answers[0].name).toBe('department');
		expect(body.answers[0].choice).toBe('billing');
		expect(body.answers[0].confidence).toBe(0.93);

		expect(upstreamRequests.length).toBe(1);
		expect(upstreamRequests[0].url).toContain('/decisions');
		expect(upstreamRequests[0].body).toEqual({
			model: 'j1',
			input: 'Check this',
			questions: [{ type: 'predicate', name: 'is_ok', instructions: 'Is it ok?' }]
		});
	});

	it('throws when the model does not exist', async () => {
		await expect(realForward(decisionsBody('nonexistent'))).rejects.toThrow(
			'No model found for decisions request'
		);
	});

	it('throws when the model lacks the decisions capability', async () => {
		createModel(getDb(), {
			providerId,
			modelId: 'no-decisions',
			capabilities: ['chat', 'streaming']
		});
		await expect(realForward(decisionsBody('no-decisions'))).rejects.toThrow(
			'does not support decisions'
		);
	});

	it('replaces the requested model id with the upstream model id', async () => {
		// model_id in DB is 'j1', user requests with that name
		await realForward(decisionsBody('j1'));
		expect(upstreamRequests[0].body).toHaveProperty('model', 'j1');
	});

	it('passes upstream errors through as DecisionsError', async () => {
		upstreamBehavior = 'not-found';
		await expect(realForward(decisionsBody('j1'))).rejects.toThrow(DecisionsError);
	});

	it('maps upstream 503 as a DecisionsError', async () => {
		upstreamBehavior = 'down';
		await expect(realForward(decisionsBody('j1'))).rejects.toThrow(DecisionsError);
	});
});

// --- API endpoint ---
describe('POST /api/v1/decisions', () => {
	it('rejects unauthenticated requests', async () => {
		const res = await call<ErrorEnvelope>({ body: decisionsBody('j1') });
		expect(res.status).toBe(401);
		expect(res.body.error.type).toBe('authentication_error');
	});

	it('rejects invalid API keys', async () => {
		const res = await call<ErrorEnvelope>({
			headers: { authorization: 'Bearer garbage' },
			body: decisionsBody('j1')
		});
		expect(res.status).toBe(401);
		expect(res.body.error.type).toBe('authentication_error');
	});

	it('rejects keys missing the llm:invoke scope', async () => {
		const noScope = (await createApiKey(getDb(), { userId: 'u1', label: 'k2', scopes: [] }))
			.rawKey;
		const res = await call<ErrorEnvelope>({
			headers: { authorization: `Bearer ${noScope}` },
			body: decisionsBody('j1')
		});
		expect(res.status).toBe(403);
		expect(res.body.error.type).toBe('permission_error');
	});

	it('rejects an invalid body with 400', async () => {
		const res = await call<ErrorEnvelope>({
			headers: auth(),
			body: { model: 'j1' }
		});
		expect(res.status).toBe(400);
		expect(res.body.error.type).toBe('invalid_request_error');
	});

	it('returns 404 for an unknown model', async () => {
		const res = await call<ErrorEnvelope>({
			headers: auth(),
			body: decisionsBody('no-such-model')
		});
		expect(res.status).toBe(404);
		expect(res.body.error.type).toBe('not_found_error');
	});

	it('returns the upstream decisions response', async () => {
		vi.mocked(mockedForward).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					answers: [
						{ type: 'choice', name: 'dept', choice: 'billing', confidence: 0.93 }
					]
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		);

		const res = await call<DecisionsResponse>({
			headers: auth(),
			body: decisionsBody('j1')
		});
		expect(res.status).toBe(200);
		expect(res.body.answers[0].type).toBe('choice');
		expect(res.body.answers[0].choice).toBe('billing');
	});

	it('logs a successful proxy request', async () => {
		vi.mocked(mockedForward).mockResolvedValueOnce(
			new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
		);

		await call<DecisionsResponse>({
			headers: auth(),
			body: decisionsBody('j1')
		});

		const { rows, total } = listProxyRequests(getDb(), {});
		expect(total).toBe(1);
		const row = rows[0];
		expect(row.status).toBe('complete');
		expect(row.endpoint).toBe('decisions');
		expect(row.requested_model).toBe('j1');
		expect(row.http_status).toBe(200);
	});

	it('logs a failed proxy request on upstream error', async () => {
		vi.mocked(mockedForward).mockRejectedValueOnce(new DecisionsError(404, 'Not found'));

		const res = await call<ErrorEnvelope>({
			headers: auth(),
			body: decisionsBody('j1')
		});
		expect(res.status).toBe(404);

		const { rows } = listProxyRequests(getDb(), {});
		const row = rows[0];
		expect(row.status).toBe('failed');
		expect(row.http_status).toBe(404);
		expect(row.error).toBeTruthy();
	});
});