import { describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

vi.mock('../llm/registry.js', async () => {
	const { MockLanguageModelV3 } = await import('ai/test');
	const { simulateReadableStream } = await import('ai');
	const state = ((
		globalThis as {
			__chatChunksState?: {
				chunks: unknown[] | null;
				lastPrompt?: unknown;
				chunkDelayMs?: number;
			};
		}
	).__chatChunksState ??= { chunks: null });
	const defaultChunks = [
		{ type: 'text-start', id: 't1' },
		{ type: 'text-delta', id: 't1', delta: 'Hi ' },
		{ type: 'text-delta', id: 't1', delta: 'there' },
		{ type: 'text-end', id: 't1' },
		{
			type: 'finish',
			finishReason: 'stop',
			usage: {
				inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
				outputTokens: { total: 2, text: 2, reasoning: undefined }
			}
		}
	];
	const model = new MockLanguageModelV3({
		doStream: async (opts) => {
			state.lastPrompt = opts.prompt;
			return {
				stream: simulateReadableStream({
					chunks: (state.chunks ?? defaultChunks) as never[],
					chunkDelayInMs: state.chunkDelayMs ?? 0
				})
			};
		}
	});
	// Target "bad" always fails before producing output, to exercise fallbacks.
	const failing = new MockLanguageModelV3({
		doStream: async () => {
			throw new Error('bad target exploded');
		}
	});
	return {
		resolveModel: (target?: { modelId: string }) => (target?.modelId === 'bad' ? failing : model),
		roleModel: () => undefined,
		ModelUnavailableError: class ModelUnavailableError extends Error {},
		__setChunks: (chunks: unknown[] | null) => {
			state.chunks = chunks;
		},
		__getLastPrompt: () => state.lastPrompt,
		__setChunkDelay: (ms: number) => {
			state.chunkDelayMs = ms;
		}
	};
});

// Tests may set `__chatFallback` to prepend a failing target that is retried.
vi.mock('../llm/mapped.js', () => {
	const flags = globalThis as { __chatFallback?: boolean };
	return {
		resolveRefTargets: (ref: { providerId: string; modelId: string }) => ({
			mappingId: null,
			targets: [
				...(flags.__chatFallback ? [{ providerId: ref.providerId, modelId: 'bad' }] : []),
				{ providerId: ref.providerId, modelId: ref.modelId }
			]
		}),
		isRetryableModelError: () => flags.__chatFallback === true
	};
});

vi.mock('ai', async () => {
	const actual = await vi.importActual<typeof import('ai')>('ai');
	return {
		...actual,
		generateImage: vi.fn(async () => ({
			image: {
				base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
				mediaType: 'image/png'
			},
			images: [
				{
					base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
					mediaType: 'image/png'
				}
			],
			warnings: [],
			responses: [],
			providerMetadata: {},
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
		}))
	};
});

const { getDb, closeDb } = await import('../db/index.js');
const { handleChatRequest } = await import('./service.js');
const { createConversation, getConversation } = await import('../db/repo/conversations.js');
const { listMessages } = await import('../db/repo/messages.js');
const { createProvider } = await import('../db/repo/providers.js');
const { createModel } = await import('../db/repo/models.js');
const { listAttachmentsByConversation } = await import('../db/repo/attachments.js');
const registry = (await import('../llm/registry.js')) as unknown as {
	__setChunks: (chunks: unknown[] | null) => void;
	__getLastPrompt: () => unknown;
	__setChunkDelay: (ms: number) => void;
};

type Db = ReturnType<typeof getDb>;

function seed(db: Db) {
	db.prepare(
		"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')"
	).run();
	createProvider(db, { name: 'P', type: 'openai-compatible' });
	db.prepare("UPDATE providers SET id = 'p1'").run();
	createModel(db, { providerId: 'p1', modelId: 'm1' });
	const conversation = createConversation(db, 'u1', { providerId: 'p1', modelId: 'm1' });
	db.prepare("UPDATE conversations SET title = 't' WHERE id = ?").run(conversation.id);
	return conversation;
}

describe('handleChatRequest', () => {
	it('persists user and assistant messages with real ids', async () => {
		const db = getDb();
		const conversation = seed(db);

		const res = await handleChatRequest('u1', {
			conversationId: conversation.id,
			message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }
		});
		expect(res.status).toBe(200);
		await res.text();
		await new Promise((r) => setTimeout(r, 50));

		const messages = listMessages(db, conversation.id);
		expect(messages).toHaveLength(2);
		const assistant = messages.find((m) => m.role === 'assistant')!;
		expect(assistant.id).toBeTruthy();
		expect(assistant.status).toBe('complete');
		expect(JSON.parse(assistant.parts)).toContainEqual(
			expect.objectContaining({ type: 'text', text: 'Hi there' })
		);
		closeDb();
	});

	it('persists assistant messages across multiple turns (no id collision)', async () => {
		const db = getDb();
		const conversation = seed(db);

		const first = await handleChatRequest('u1', {
			conversationId: conversation.id,
			message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }
		});
		await first.text();
		await new Promise((r) => setTimeout(r, 50));
		const afterFirst = listMessages(db, conversation.id);
		const assistant1 = afterFirst.find((m) => m.role === 'assistant')!;

		// second request sends only the new user message; history comes from the DB
		const second = await handleChatRequest('u1', {
			conversationId: conversation.id,
			message: { id: 'msg-2', role: 'user', parts: [{ type: 'text', text: 'again' }] }
		});
		expect(second.status).toBe(200);
		await second.text();
		await new Promise((r) => setTimeout(r, 50));

		const messages = listMessages(db, conversation.id);
		expect(messages).toHaveLength(4);
		const assistants = messages.filter((m) => m.role === 'assistant');
		expect(new Set(assistants.map((m) => m.id)).size).toBe(2);
		expect(assistant1.id).toBeTruthy();
		closeDb();
	});

	it('does not wipe history when the client sends only the new message', async () => {
		const db = getDb();
		const conversation = seed(db);

		const first = await handleChatRequest('u1', {
			conversationId: conversation.id,
			message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }
		});
		await first.text();
		await new Promise((r) => setTimeout(r, 50));
		expect(listMessages(db, conversation.id)).toHaveLength(2);

		// a stale/buggy client sends only the new message without prior history
		const second = await handleChatRequest('u1', {
			conversationId: conversation.id,
			message: { id: 'msg-2', role: 'user', parts: [{ type: 'text', text: 'again' }] }
		});
		await second.text();
		await new Promise((r) => setTimeout(r, 50));

		expect(listMessages(db, conversation.id)).toHaveLength(4);
		closeDb();
	});

	it('truncateFrom deletes the anchor and later messages, then upserts the new message', async () => {
		const db = getDb();
		const conversation = seed(db);

		const first = await handleChatRequest('u1', {
			conversationId: conversation.id,
			message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }
		});
		await first.text();
		await new Promise((r) => setTimeout(r, 50));
		const assistant1 = listMessages(db, conversation.id).find((m) => m.role === 'assistant')!;

		// regenerate: drop the assistant answer and everything after, resubmit the user message
		const res = await handleChatRequest('u1', {
			conversationId: conversation.id,
			message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
			truncateFrom: assistant1.id
		});
		expect(res.status).toBe(200);
		await res.text();
		await new Promise((r) => setTimeout(r, 50));

		const messages = listMessages(db, conversation.id);
		expect(messages).toHaveLength(2);
		expect(messages[0].id).toBe('msg-1');
		expect(messages[1].role).toBe('assistant');
		expect(messages[1].id).not.toBe(assistant1.id);
		closeDb();
	});

	it('rejects with 400 when truncateFrom references an unknown message', async () => {
		const db = getDb();
		const conversation = seed(db);

		await expect(
			handleChatRequest('u1', {
				conversationId: conversation.id,
				message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
				truncateFrom: 'does-not-exist'
			})
		).rejects.toMatchObject({ status: 400, message: expect.stringContaining('truncateFrom') });
		closeDb();
	});

	it('rejects with 400 when the triggering message is not a user message', async () => {
		const db = getDb();
		const conversation = seed(db);

		await expect(
			handleChatRequest('u1', {
				conversationId: conversation.id,
				message: { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }
			})
		).rejects.toMatchObject({ status: 400, message: expect.stringContaining('user message') });
		closeDb();
	});

	it('sets a provisional title from the first user message when empty', async () => {
		const db = getDb();
		db.prepare(
			"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')"
		).run();
		createProvider(db, { name: 'P', type: 'openai-compatible' });
		db.prepare("UPDATE providers SET id = 'p1'").run();
		createModel(db, { providerId: 'p1', modelId: 'm1' });
		const conversation = createConversation(db, 'u1', { providerId: 'p1', modelId: 'm1' });

		expect(getConversation(db, 'u1', conversation.id)!.title).toBe('');

		const res = await handleChatRequest('u1', {
			conversationId: conversation.id,
			message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello world' }] }
		});
		expect(res.status).toBe(200);
		await res.text();
		await new Promise((r) => setTimeout(r, 50));

		const title = getConversation(db, 'u1', conversation.id)!.title;
		expect(title).toBeTruthy();
		expect(title).not.toBe('');
		closeDb();
	});

	it('truncates long first messages at a word boundary and appends ellipsis', async () => {
		const db = getDb();
		db.prepare(
			"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')"
		).run();
		createProvider(db, { name: 'P', type: 'openai-compatible' });
		db.prepare("UPDATE providers SET id = 'p1'").run();
		createModel(db, { providerId: 'p1', modelId: 'm1' });
		const conversation = createConversation(db, 'u1', { providerId: 'p1', modelId: 'm1' });

		const longPrompt = Array.from({ length: 20 }, (_, i) => `word${i + 1}`).join(' ');

		const res = await handleChatRequest('u1', {
			conversationId: conversation.id,
			message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: longPrompt }] }
		});
		expect(res.status).toBe(200);
		await res.text();
		await new Promise((r) => setTimeout(r, 50));

		const title = getConversation(db, 'u1', conversation.id)!.title;
		expect(title.endsWith('\u2026')).toBe(true);
		expect(title.split(' ').pop()).not.toBe('\u2026');
		closeDb();
	});

	it('persists usage metadata on the assistant message', async () => {
		const db = getDb();
		const conversation = seed(db);

		const res = await handleChatRequest('u1', {
			conversationId: conversation.id,
			message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }
		});
		expect(res.status).toBe(200);
		const body = await res.text();
		await new Promise((r) => setTimeout(r, 50));

		// metadata chunk streamed to the client
		expect(body).toContain('"usage"');

		const assistant = listMessages(db, conversation.id).find((m) => m.role === 'assistant')!;
		const usage = JSON.parse(assistant.usage_json!) as Record<string, unknown>;
		expect(usage).toMatchObject({
			providerId: 'p1',
			modelId: 'm1',
			inputTokens: 1,
			outputTokens: 2,
			totalTokens: 3
		});
		expect(typeof usage.latencyMs).toBe('number');
		closeDb();
	});

	it('persists reasoning and tool output when the stream has no text-delta', async () => {
		const db = getDb();
		const conversation = seed(db);
		registry.__setChunks([
			{ type: 'reasoning-start', id: 'r1' },
			{ type: 'reasoning-delta', id: 'r1', delta: 'thinking hard' },
			{ type: 'reasoning-end', id: 'r1' },
			{
				type: 'finish',
				finishReason: 'stop',
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
					outputTokens: { total: 2, text: 2, reasoning: undefined }
				}
			}
		]);
		try {
			const res = await handleChatRequest('u1', {
				conversationId: conversation.id,
				message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }
			});
			expect(res.status).toBe(200);
			await res.text();
			await new Promise((r) => setTimeout(r, 50));

			const assistant = listMessages(db, conversation.id).find((m) => m.role === 'assistant')!;
			const parts = JSON.parse(assistant.parts) as { type: string }[];
			expect(parts.length).toBeGreaterThan(0);
			expect(assistant.status).toBe('complete');
		} finally {
			registry.__setChunks(null);
			closeDb();
		}
	});

	it('creates the assistant row up front and fills it while streaming', async () => {
		const db = getDb();
		const conversation = seed(db);

		const res = await handleChatRequest('u1', {
			conversationId: conversation.id,
			message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }
		});
		expect(res.status).toBe(200);

		// the assistant row exists immediately, before the stream is consumed
		const assistantEarly = listMessages(db, conversation.id).find((m) => m.role === 'assistant')!;
		expect(assistantEarly).toBeTruthy();

		const body = await res.text();
		await new Promise((r) => setTimeout(r, 100));

		const assistant = listMessages(db, conversation.id).find((m) => m.role === 'assistant')!;
		// same row, updated in place
		expect(assistant.id).toBe(assistantEarly.id);
		expect(assistant.status).toBe('complete');
		expect(JSON.parse(assistant.parts)).toContainEqual(
			expect.objectContaining({ type: 'text', text: 'Hi there' })
		);
		// the client stream carried the stable message id
		expect(body).toContain(assistant.id);
		closeDb();
	});

	it('regenerate keeps an assistant row during streaming and leaves a complete one after', async () => {
		const db = getDb();
		const conversation = seed(db);

		const first = await handleChatRequest('u1', {
			conversationId: conversation.id,
			message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }
		});
		await first.text();
		await new Promise((r) => setTimeout(r, 50));
		const assistant1 = listMessages(db, conversation.id).find((m) => m.role === 'assistant')!;

		const second = await handleChatRequest('u1', {
			conversationId: conversation.id,
			message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
			truncateFrom: assistant1.id
		});
		expect(second.status).toBe(200);

		// mid-stream: the truncated message is replaced by a fresh in-flight row
		const duringMessages = listMessages(db, conversation.id);
		expect(duringMessages.filter((m) => m.role === 'assistant')).toHaveLength(1);

		await second.text();
		await new Promise((r) => setTimeout(r, 50));

		const messages = listMessages(db, conversation.id);
		expect(messages).toHaveLength(2);
		const assistant2 = messages.find((m) => m.role === 'assistant')!;
		expect(assistant2.id).not.toBe(assistant1.id);
		expect(assistant2.status).toBe('complete');
		expect(JSON.parse(assistant2.parts).length).toBeGreaterThan(0);
		closeDb();
	});

	it('rejects with 400 when the selected model is disabled', async () => {
		const db = getDb();
		db.prepare(
			"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')"
		).run();
		const provider = createProvider(db, { name: 'P', type: 'openai-compatible' });
		createModel(db, { providerId: provider.id, modelId: 'm1', enabled: false });
		const conversation = createConversation(db, 'u1', {
			providerId: provider.id,
			modelId: 'm1'
		});

		await expect(
			handleChatRequest('u1', {
				conversationId: conversation.id,
				message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }
			})
		).rejects.toMatchObject({
			status: 400,
			message: expect.stringContaining('disabled')
		});
		closeDb();
	});

	it('emits file parts and links attachments when generate_image runs', async () => {
		process.env.WORKSPACES_VOLUME = '.test-workspaces-chat';
		const fsp = await import('node:fs/promises');
		try {
			const db = getDb();
			const conversation = seed(db);
			const { createAttachment } = await import('../db/repo/attachments.js');
			const pre = createAttachment(db, {
				kind: 'image',
				path: `${conversation.id}/attachments/pre-generated.png`,
				mime: 'image/png',
				sha256: 'x'
			});
			registry.__setChunks([
				{
					type: 'tool-call',
					toolCallId: 'tc1',
					toolName: 'generate_image',
					input: { prompt: 'a cat' }
				},
				{
					type: 'tool-result',
					toolCallId: 'tc1',
					toolName: 'generate_image',
					result: {
						content: [{ type: 'text', text: 'Generated 1 image(s)' }],
						structuredContent: { attachmentIds: [pre.id] }
					}
				},
				{ type: 'text-start', id: 't1' },
				{ type: 'text-delta', id: 't1', delta: 'Here is your image' },
				{ type: 'text-end', id: 't1' },
				{
					type: 'finish',
					finishReason: 'stop',
					usage: {
						inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
						outputTokens: { total: 2, text: 2, reasoning: undefined }
					}
				}
			]);
			const res = await handleChatRequest('u1', {
				conversationId: conversation.id,
				message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'draw a cat' }] }
			});
			expect(res.status).toBe(200);
			const body = await res.text();
			await new Promise((r) => setTimeout(r, 100));

			const attachments = listAttachmentsByConversation(db, conversation.id);
			expect(attachments).toHaveLength(1);
			expect(attachments[0].kind).toBe('image');
			const assistant = listMessages(db, conversation.id).find((m) => m.role === 'assistant')!;
			expect(attachments[0].message_id).toBe(assistant.id);
			const parts = JSON.parse(assistant.parts) as { type: string; url?: string }[];
			const filePart = parts.find((p) => p.type === 'file');
			expect(filePart).toBeDefined();
			expect(filePart!.url).toContain(
				`/api/conversations/${conversation.id}/attachments/${attachments[0].id}`
			);
			expect(body).toContain('"type":"file"');
		} finally {
			registry.__setChunks(null);
			await fsp.rm('.test-workspaces-chat', { recursive: true, force: true });
			delete process.env.WORKSPACES_VOLUME;
			closeDb();
		}
	});

	it('injects an attachment-id note before image file parts sent to the model', async () => {
		const fsp = await import('node:fs/promises');
		let createdDir = '';
		try {
			const db = getDb();
			const conversation = seed(db);
			const { createAttachment } = await import('../db/repo/attachments.js');
			createdDir = `workspaces/${conversation.id}`;
			const dir = `${createdDir}/attachments`;
			await fsp.mkdir(dir, { recursive: true });
			await fsp.writeFile(`${dir}/photo.jpg`, Buffer.from([0xff, 0xd8, 0xff, 1]));
			const att = createAttachment(db, {
				kind: 'image',
				path: `${conversation.id}/attachments/photo.jpg`,
				mime: 'image/jpeg',
				sha256: 'x'
			});
			const res = await handleChatRequest('u1', {
				conversationId: conversation.id,
				message: {
					id: 'msg-1',
					role: 'user',
					parts: [
						{ type: 'text', text: 'edit this' },
						{
							type: 'file',
							url: `/api/conversations/${conversation.id}/attachments/${att.id}`,
							mediaType: 'image/jpeg',
							filename: 'photo.jpg'
						}
					]
				}
			});
			expect(res.status).toBe(200);
			await res.text();
			await new Promise((r) => setTimeout(r, 100));

			const prompt = registry.__getLastPrompt() as {
				role: string;
				content: { type: string; text?: string }[];
			}[];
			const userMsg = prompt.find((m) => m.role === 'user')!;
			const note = userMsg.content.find(
				(c) => c.type === 'text' && c.text?.includes('[attachment id:')
			);
			expect(note).toBeDefined();
			expect(note!.text).toContain(att.id);
		} finally {
			registry.__setChunks(null);
			if (createdDir) await fsp.rm(createdDir, { recursive: true, force: true });
			closeDb();
		}
	});

	it('ignores attachments stored under another conversation', async () => {
		const fsp = await import('node:fs/promises');
		registry.__setChunks(null);
		let createdDir = '';
		try {
			const db = getDb();
			const conversation = seed(db);
			const victim = createConversation(db, 'u1', { providerId: 'p1', modelId: 'm1' });
			const { createAttachment, getAttachment } = await import('../db/repo/attachments.js');
			createdDir = `workspaces/${victim.id}`;
			const dir = `${createdDir}/attachments`;
			await fsp.mkdir(dir, { recursive: true });
			const secret = Buffer.from('victim-secret-bytes');
			await fsp.writeFile(`${dir}/secret.png`, secret);
			const att = createAttachment(db, {
				kind: 'image',
				path: `${victim.id}/attachments/secret.png`,
				mime: 'image/png',
				sha256: 'x'
			});

			const res = await handleChatRequest('u1', {
				conversationId: conversation.id,
				message: {
					id: 'msg-1',
					role: 'user',
					parts: [
						{ type: 'text', text: 'describe this' },
						{
							type: 'file',
							url: `/api/conversations/${conversation.id}/attachments/${att.id}`,
							mediaType: 'image/png',
							filename: 'secret.png'
						}
					]
				}
			});
			expect(res.status).toBe(200);
			await res.text();
			await new Promise((r) => setTimeout(r, 100));

			const prompt = JSON.stringify(registry.__getLastPrompt());
			expect(prompt).toContain('describe this');
			expect(prompt).not.toContain(att.id);
			expect(prompt).not.toContain(secret.toString('base64'));
			expect(getAttachment(db, att.id)!.message_id).toBeNull();
		} finally {
			if (createdDir) await fsp.rm(createdDir, { recursive: true, force: true });
			closeDb();
		}
	});

	it('saves output while streaming, and keeps the full text once finished', async () => {
		registry.__setChunkDelay(400);
		try {
			const db = getDb();
			const conversation = seed(db);
			const res = await handleChatRequest('u1', {
				conversationId: conversation.id,
				message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }
			});
			const reading = res.text();

			const assistant = () =>
				listMessages(db, conversation.id).find((m) => m.role === 'assistant')!;
			await vi.waitFor(
				() => {
					expect(assistant().status).toBe('partial');
					expect(assistant().content_text).toContain('Hi');
				},
				{ timeout: 3000 }
			);

			await reading;
			await new Promise((r) => setTimeout(r, 700));
			expect(assistant().status).toBe('complete');
			expect(assistant().content_text).toBe('Hi there');
		} finally {
			registry.__setChunkDelay(0);
			closeDb();
		}
	});

	it('marks an aborted response as failed, not partial', async () => {
		registry.__setChunks([
			{ type: 'text-start', id: 't1' },
			{ type: 'text-delta', id: 't1', delta: 'Hi ' }
		]);
		const { abortStream } = await import('./streams.js');
		try {
			const db = getDb();
			const conversation = seed(db);
			const res = await handleChatRequest('u1', {
				conversationId: conversation.id,
				message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }
			});
			abortStream(conversation.id);
			await res.text();
			await new Promise((r) => setTimeout(r, 100));

			const statuses = listMessages(db, conversation.id).map((m) => m.status);
			expect(statuses).not.toContain('partial');
		} finally {
			registry.__setChunks(null);
			closeDb();
		}
	});

	it('records a response from a fallback target as complete, not failed', async () => {
		const flags = globalThis as { __chatFallback?: boolean };
		flags.__chatFallback = true;
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const db = getDb();
			const conversation = seed(db);
			createModel(db, { providerId: 'p1', modelId: 'bad' });
			const res = await handleChatRequest('u1', {
				conversationId: conversation.id,
				message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }
			});
			await res.text();
			await new Promise((r) => setTimeout(r, 50));

			const assistant = listMessages(db, conversation.id).find((m) => m.role === 'assistant')!;
			expect(assistant.status).toBe('complete');
			expect(assistant.error).toBeNull();
			expect(assistant.parts).toContain('Hi there');
		} finally {
			flags.__chatFallback = false;
			consoleError.mockRestore();
			closeDb();
		}
	});

	it('releases the stream and drops the placeholder when setup throws', async () => {
		const { hasActiveStream } = await import('./streams.js');
		const { createAgent } = await import('../db/repo/agents.js');
		try {
			const db = getDb();
			const conversation = seed(db);
			const agent = createAgent(db, 'u1', { name: 'a', systemPrompt: 'x', triggerType: 'manual' });
			db.prepare("UPDATE agents SET skill_names = 'not json' WHERE id = ?").run(agent.id);
			db.prepare('UPDATE conversations SET agent_id = ? WHERE id = ?').run(
				agent.id,
				conversation.id
			);

			await expect(
				handleChatRequest('u1', {
					conversationId: conversation.id,
					message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }
				})
			).rejects.toThrow();
			expect(hasActiveStream(conversation.id)).toBe(false);
			expect(listMessages(db, conversation.id).map((m) => m.role)).toEqual(['user']);
		} finally {
			closeDb();
		}
	});

	it('rejects with 400 when the selected provider is disabled', async () => {
		const db = getDb();
		db.prepare(
			"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')"
		).run();
		const provider = createProvider(db, {
			name: 'P',
			type: 'openai-compatible',
			enabled: false
		});
		createModel(db, { providerId: provider.id, modelId: 'm1' });
		const conversation = createConversation(db, 'u1', {
			providerId: provider.id,
			modelId: 'm1'
		});

		await expect(
			handleChatRequest('u1', {
				conversationId: conversation.id,
				message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }
			})
		).rejects.toMatchObject({
			status: 400,
			message: expect.stringContaining('unavailable')
		});
		closeDb();
	});
});
