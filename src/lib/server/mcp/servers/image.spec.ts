import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.WORKSPACES_VOLUME = '.test-workspaces-image';

const generateImageMock = vi.fn();

vi.mock('ai', async () => {
	const actual = await vi.importActual<typeof import('ai')>('ai');
	return { ...actual, generateImage: (...args: unknown[]) => generateImageMock(...args) };
});

const { createImageServer } = await import('./image.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');
const { getDb, closeDb } = await import('../../db/index.js');
const { setRoleDefault } = await import('../../db/repo/models.js');
const { createProvider } = await import('../../db/repo/providers.js');
const { createModel } = await import('../../db/repo/models.js');
const { getAttachment, createAttachment, linkAttachmentsToMessage } =
	await import('../../db/repo/attachments.js');
const { createConversation } = await import('../../db/repo/conversations.js');
const { createMessage } = await import('../../db/repo/messages.js');
const fsp = await import('node:fs/promises');
const path = await import('node:path');
const { NoImageGeneratedError } = await import('ai');

const USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

const CTX = {
	userId: 'u1',
	role: 'user',
	workspaceDir: null,
	documentsDir: '',
	conversationId: 'conv-1'
};

function pngBase64(): string {
	return Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64');
}

async function callTool(name: 'generate_image' | 'edit_image', args: Record<string, unknown>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createImageServer(CTX);
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tools = await client.tools();
		const tool = tools[name] as unknown as {
			execute: (input: unknown, opts: unknown) => Promise<unknown>;
		};
		return await tool.execute(args, { toolCallId: 't1', messages: [] });
	} finally {
		await client.close();
		await server.close();
	}
}

function callGenerate(args: Record<string, unknown>) {
	return callTool('generate_image', args);
}

function callEdit(args: Record<string, unknown>) {
	return callTool('edit_image', args);
}

function resultText(res: unknown): string {
	const r = res as { content?: Array<{ type: string; text?: string }> };
	return r.content?.[0]?.text ?? '';
}

function seedModel() {
	const db = getDb();
	createProvider(db, { name: 'Prov', type: 'openai-compatible', baseUrl: 'http://x' });
	db.prepare("UPDATE providers SET id = 'p1'").run();
	const model = createModel(db, { providerId: 'p1', modelId: 'img-1', capabilities: ['image'] });
	setRoleDefault(db, 'image', model.id);
}

describe('image server', () => {
	beforeEach(() => {
		closeDb();
		generateImageMock.mockReset();
	});

	afterEach(async () => {
		await fsp.rm(path.resolve('.test-workspaces-image'), { recursive: true, force: true });
	});

	it('returns friendly error when no image model configured', async () => {
		const res = await callGenerate({ prompt: 'a cat' });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('not configured');
	});

	it('generates, persists attachment rows, and returns attachmentIds payload', async () => {
		const db = getDb();
		seedModel();
		generateImageMock.mockResolvedValue({
			image: { base64: pngBase64(), mediaType: 'image/png' },
			images: [{ base64: pngBase64(), mediaType: 'image/png' }],
			warnings: [],
			responses: [],
			providerMetadata: {},
			usage: USAGE
		});
		const res = await callGenerate({ prompt: 'a cat' });
		expect((res as { isError?: boolean }).isError).not.toBe(true);
		const sc = (res as { structuredContent?: { attachmentIds?: string[] } }).structuredContent;
		expect(sc?.attachmentIds).toHaveLength(1);
		const row = getAttachment(db, sc!.attachmentIds![0]);
		expect(row).toBeDefined();
		expect(row!.kind).toBe('image');
		expect(row!.mime).toBe('image/png');
		const abs = path.resolve('.test-workspaces-image', row!.path);
		const bytes = await fsp.readFile(abs);
		expect(bytes.length).toBeGreaterThan(0);
		expect(resultText(res)).toContain('Generated 1 image(s)');
	});

	it('passes n and maxImagesPerCall through to the SDK', async () => {
		seedModel();
		generateImageMock.mockResolvedValue({
			image: { base64: pngBase64(), mediaType: 'image/png' },
			images: [{ base64: pngBase64(), mediaType: 'image/png' }],
			warnings: [],
			responses: [],
			providerMetadata: {},
			usage: USAGE
		});
		await callGenerate({ prompt: 'x', n: 3 });
		const call = generateImageMock.mock.calls[0][0] as { n: number; maxImagesPerCall: number };
		expect(call.n).toBe(3);
		expect(call.maxImagesPerCall).toBe(4);
	});

	it('passes size, aspectRatio and provider options through', async () => {
		seedModel();
		generateImageMock.mockResolvedValue({
			image: { base64: pngBase64(), mediaType: 'image/png' },
			images: [{ base64: pngBase64(), mediaType: 'image/png' }],
			warnings: [],
			responses: [],
			providerMetadata: {},
			usage: USAGE
		});
		await callGenerate({ prompt: 'x', aspectRatio: '16:9', quality: 'hd', style: 'vivid' });
		const call = generateImageMock.mock.calls[0][0] as Record<string, unknown>;
		expect(call.aspectRatio).toBe('16:9');
		expect(call.size).toBeUndefined();
		expect(call.providerOptions).toEqual({ p1: { quality: 'hd', style: 'vivid' } });
	});

	it('omits size and aspectRatio when neither is given', async () => {
		seedModel();
		generateImageMock.mockResolvedValue({
			image: { base64: pngBase64(), mediaType: 'image/png' },
			images: [{ base64: pngBase64(), mediaType: 'image/png' }],
			warnings: [],
			responses: [],
			providerMetadata: {},
			usage: USAGE
		});
		await callGenerate({ prompt: 'x' });
		const call = generateImageMock.mock.calls[0][0] as Record<string, unknown>;
		expect(call.size).toBeUndefined();
		expect(call.aspectRatio).toBeUndefined();
	});

	it('rejects passing both size and aspectRatio', async () => {
		seedModel();
		const res = await callGenerate({ prompt: 'x', size: '512x512', aspectRatio: '1:1' });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('only one of size or aspectRatio');
		expect(generateImageMock).not.toHaveBeenCalled();
	});

	it('surfaces warnings and revised prompt in result text', async () => {
		seedModel();
		generateImageMock.mockResolvedValue({
			image: { base64: pngBase64(), mediaType: 'image/png' },
			images: [{ base64: pngBase64(), mediaType: 'image/png' }],
			warnings: [{ type: 'unsupported', feature: 'size', details: 'ignored by provider' }],
			responses: [],
			providerMetadata: { p1: { revisedPrompt: 'a fluffy cat, studio lighting' } },
			usage: USAGE
		});
		const res = await callGenerate({ prompt: 'a cat' });
		const out = resultText(res);
		expect(out).toContain('Revised prompt: a fluffy cat, studio lighting');
		expect(out).toContain('Warnings: unsupported: size (ignored by provider)');
	});

	it('maps NoImageGeneratedError to a clean error', async () => {
		seedModel();
		generateImageMock.mockRejectedValue(
			new NoImageGeneratedError({ message: 'no image returned' })
		);
		const res = await callGenerate({ prompt: 'x' });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('image generation failed: no image returned');
	});

	it('maps provider errors to a clean error', async () => {
		seedModel();
		generateImageMock.mockRejectedValue(new Error('HTTP 401 unauthorized'));
		const res = await callGenerate({ prompt: 'x' });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('HTTP 401');
	});
});

describe('edit_image', () => {
	beforeEach(() => {
		closeDb();
		generateImageMock.mockReset();
	});

	afterEach(async () => {
		await fsp.rm(path.resolve('.test-workspaces-image'), { recursive: true, force: true });
	});

	it('returns friendly error when no image model configured', async () => {
		const res = await callEdit({ prompt: 'make it brighter', image: pngBase64() });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('not configured');
	});

	it('passes the image through as a structured prompt and saves the result', async () => {
		const db = getDb();
		seedModel();
		generateImageMock.mockResolvedValue({
			image: { base64: pngBase64(), mediaType: 'image/png' },
			images: [{ base64: pngBase64(), mediaType: 'image/png' }],
			warnings: [],
			responses: [],
			providerMetadata: {},
			usage: USAGE
		});
		const src = pngBase64();
		const res = await callEdit({ prompt: 'remove the background', image: src });
		expect((res as { isError?: boolean }).isError).not.toBe(true);
		const call = generateImageMock.mock.calls[0][0] as {
			prompt: { images: string[]; text: string };
			n: number;
		};
		expect(call.prompt).toEqual({ images: [src], text: 'remove the background' });
		expect(call.n).toBe(1);
		const sc = (res as { structuredContent?: { attachmentIds?: string[] } }).structuredContent;
		expect(sc?.attachmentIds).toHaveLength(1);
		const row = getAttachment(db, sc!.attachmentIds![0]);
		expect(row).toBeDefined();
		expect(row!.kind).toBe('image');
		expect(resultText(res)).toContain('Edited 1 image(s)');
	});

	it('strips whitespace from base64 before sending', async () => {
		seedModel();
		generateImageMock.mockResolvedValue({
			image: { base64: pngBase64(), mediaType: 'image/png' },
			images: [{ base64: pngBase64(), mediaType: 'image/png' }],
			warnings: [],
			responses: [],
			providerMetadata: {},
			usage: USAGE
		});
		const src = pngBase64();
		const withWhitespace = `${src.slice(0, 4)}\n${src.slice(4)}`;
		await callEdit({ prompt: 'x', image: withWhitespace });
		const call = generateImageMock.mock.calls[0][0] as { prompt: { images: string[] } };
		expect(call.prompt.images[0]).toBe(src);
	});

	it('rejects non-base64 input', async () => {
		seedModel();
		const res = await callEdit({ prompt: 'x', image: 'not base64!!!' });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('base64');
		expect(generateImageMock).not.toHaveBeenCalled();
	});

	it('loads the source image from an attachment ID', async () => {
		const db = getDb();
		seedModel();
		db.prepare(
			"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'u1@example.com', 0, 0, 0, 'user')"
		).run();
		const conv = createConversation(db, 'u1', { title: 't' });
		db.prepare('UPDATE conversations SET id = ? WHERE id = ?').run(CTX.conversationId, conv.id);
		const msg = createMessage(db, { conversationId: CTX.conversationId, role: 'user', parts: [] });
		const dir = path.resolve('.test-workspaces-image', CTX.conversationId, 'attachments');
		await fsp.mkdir(dir, { recursive: true });
		const filename = 'source.jpg';
		const srcBytes = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
		await fsp.writeFile(path.join(dir, filename), srcBytes);
		const src = createAttachment(db, {
			kind: 'image',
			path: path.join(CTX.conversationId, 'attachments', filename),
			mime: 'image/jpeg',
			sha256: 'x'
		});
		linkAttachmentsToMessage(db, msg.id, [src.id]);
		generateImageMock.mockResolvedValue({
			image: { base64: pngBase64(), mediaType: 'image/png' },
			images: [{ base64: pngBase64(), mediaType: 'image/png' }],
			warnings: [],
			responses: [],
			providerMetadata: {},
			usage: USAGE
		});
		const res = await callEdit({ prompt: 'add a carpet', image: src.id });
		expect((res as { isError?: boolean }).isError).not.toBe(true);
		const call = generateImageMock.mock.calls[0][0] as { prompt: { images: string[] } };
		expect(call.prompt.images[0]).toBe(srcBytes.toString('base64'));
		const sc = (res as { structuredContent?: { attachmentIds?: string[] } }).structuredContent;
		expect(sc?.attachmentIds).toHaveLength(1);
	});

	it('extracts an attachment ID embedded in a larger reference string', async () => {
		const db = getDb();
		seedModel();
		db.prepare(
			"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'u1@example.com', 0, 0, 0, 'user')"
		).run();
		const conv = createConversation(db, 'u1', { title: 't' });
		db.prepare('UPDATE conversations SET id = ? WHERE id = ?').run(CTX.conversationId, conv.id);
		const msg = createMessage(db, { conversationId: CTX.conversationId, role: 'user', parts: [] });
		const dir = path.resolve('.test-workspaces-image', CTX.conversationId, 'attachments');
		await fsp.mkdir(dir, { recursive: true });
		const filename = 'source.png';
		await fsp.writeFile(path.join(dir, filename), Buffer.from([1, 2, 3]));
		const src = createAttachment(db, {
			kind: 'image',
			path: path.join(CTX.conversationId, 'attachments', filename),
			mime: 'image/png',
			sha256: 'x'
		});
		linkAttachmentsToMessage(db, msg.id, [src.id]);
		generateImageMock.mockResolvedValue({
			image: { base64: pngBase64(), mediaType: 'image/png' },
			images: [{ base64: pngBase64(), mediaType: 'image/png' }],
			warnings: [],
			responses: [],
			providerMetadata: {},
			usage: USAGE
		});
		const res = await callEdit({
			prompt: 'x',
			image: `/api/conversations/${CTX.conversationId}/attachments/${src.id}`
		});
		expect((res as { isError?: boolean }).isError).not.toBe(true);
		expect(generateImageMock).toHaveBeenCalled();
	});

	it('rejects an unknown attachment ID', async () => {
		seedModel();
		const res = await callEdit({
			prompt: 'x',
			image: '11111111-2222-3333-4444-555555555555'
		});
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('no image attachment found');
		expect(generateImageMock).not.toHaveBeenCalled();
	});

	it('rejects oversized images', async () => {
		seedModel();
		const big = 'A'.repeat(20 * 1024 * 1024 + 4);
		const res = await callEdit({ prompt: 'x', image: big });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('too large');
		expect(generateImageMock).not.toHaveBeenCalled();
	});

	it('maps NoImageGeneratedError to a clean error', async () => {
		seedModel();
		generateImageMock.mockRejectedValue(new NoImageGeneratedError({ message: 'edit failed' }));
		const res = await callEdit({ prompt: 'x', image: pngBase64() });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('image editing failed: edit failed');
	});

	it('maps provider errors to a clean error', async () => {
		seedModel();
		generateImageMock.mockRejectedValue(new Error('model does not support image input'));
		const res = await callEdit({ prompt: 'x', image: pngBase64() });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('does not support image input');
	});
});
