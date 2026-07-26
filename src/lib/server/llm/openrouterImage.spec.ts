import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenRouterImageModel } from './openrouterImage.js';

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
	vi.stubGlobal(
		'fetch',
		vi.fn((url: unknown, init: unknown) => handler(String(url), init as RequestInit))
	);
}

function fetchCalls(): { url: string; body: Record<string, unknown>; headers: Headers }[] {
	const mock = fetch as unknown as ReturnType<typeof vi.fn>;
	return mock.mock.calls.map(([url, init]) => ({
		url: String(url),
		body: JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
		headers: new Headers((init as RequestInit).headers)
	}));
}

const OK = new Response(
	JSON.stringify({
		data: [{ b64_json: 'aGVsbG8=', media_type: 'image/png' }],
		usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
	}),
	{ status: 200, headers: { 'content-type': 'application/json' } }
);

describe('createOpenRouterImageModel', () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const model = () =>
		createOpenRouterImageModel({
			provider: 'openrouter',
			modelId: 'google/gemini-2.5-flash-image',
			baseURL: 'https://openrouter.ai/api/v1',
			apiKey: 'sk-test'
		});

	it('posts JSON to {base}/images with auth header', async () => {
		mockFetch(() => OK.clone());
		const m = model();
		const result = await m.doGenerate({
			prompt: 'a cat',
			n: 1,
			size: undefined,
			aspectRatio: undefined,
			seed: undefined,
			files: undefined,
			mask: undefined,
			providerOptions: {}
		});
		expect(result.images).toEqual(['aGVsbG8=']);
		const [call] = fetchCalls();
		expect(call.url).toBe('https://openrouter.ai/api/v1/images');
		expect(call.headers.get('authorization')).toBe('Bearer sk-test');
		expect(call.body.model).toBe('google/gemini-2.5-flash-image');
		expect(call.body.prompt).toBe('a cat');
		expect(call.body.n).toBe(1);
		expect(call.body.input_references).toBeUndefined();
	});

	it('maps size/aspectRatio/seed to OpenRouter fields', async () => {
		mockFetch(() => OK.clone());
		const m = model();
		await m.doGenerate({
			prompt: 'x',
			n: 2,
			size: '1024x1024',
			aspectRatio: undefined,
			seed: 42,
			files: undefined,
			mask: undefined,
			providerOptions: {}
		});
		const [call] = fetchCalls();
		expect(call.body.size).toBe('1024x1024');
		expect(call.body.seed).toBe(42);
		expect(call.body.n).toBe(2);
	});

	it('converts files to input_references with data URLs', async () => {
		mockFetch(() => OK.clone());
		const m = model();
		await m.doGenerate({
			prompt: 'edit it',
			n: 1,
			size: undefined,
			aspectRatio: undefined,
			seed: undefined,
			files: [{ type: 'file', mediaType: 'image/jpeg', data: 'anJwbGc=' }],
			mask: undefined,
			providerOptions: {}
		});
		const [call] = fetchCalls();
		expect(call.body.input_references).toEqual([
			{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,anJwbGc=' } }
		]);
	});

	it('warns about unsupported mask', async () => {
		mockFetch(() => OK.clone());
		const m = model();
		const result = await m.doGenerate({
			prompt: 'x',
			n: 1,
			size: undefined,
			aspectRatio: undefined,
			seed: undefined,
			files: undefined,
			mask: { type: 'file', mediaType: 'image/png', data: 'eA==' },
			providerOptions: {}
		});
		expect(result.warnings).toContainEqual({ type: 'unsupported', feature: 'mask' });
	});

	it('throws a clean error on HTTP failure with error body', async () => {
		mockFetch(
			() => new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 })
		);
		const m = model();
		await expect(
			m.doGenerate({
				prompt: 'x',
				n: 1,
				size: undefined,
				aspectRatio: undefined,
				seed: undefined,
				files: undefined,
				mask: undefined,
				providerOptions: {}
			})
		).rejects.toThrow('model not found');
	});

	it('throws when the response contains no images', async () => {
		mockFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
		const m = model();
		await expect(
			m.doGenerate({
				prompt: 'x',
				n: 1,
				size: undefined,
				aspectRatio: undefined,
				seed: undefined,
				files: undefined,
				mask: undefined,
				providerOptions: {}
			})
		).rejects.toThrow('no images');
	});
});
