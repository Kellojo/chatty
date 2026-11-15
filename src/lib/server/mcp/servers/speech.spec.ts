import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.WORKSPACES_VOLUME = '.test-workspaces-speech';

const { createSpeechServer } = await import('./speech.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');
const { getDb, closeDb } = await import('../../db/index.js');
const { createModel, setRoleDefault } = await import('../../db/repo/models.js');
const { createProvider } = await import('../../db/repo/providers.js');
const { createAttachment, linkAttachmentsToMessage } = await import('../../db/repo/attachments.js');
const { createConversation } = await import('../../db/repo/conversations.js');
const { createMessage } = await import('../../db/repo/messages.js');
const fsp = await import('node:fs/promises');
const path = await import('node:path');

const CTX = {
	userId: 'u1',
	role: 'user',
	workspaceDir: null,
	documentsDir: '',
	conversationId: 'conv-1'
};

async function callTranscribe(args: Record<string, unknown>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createSpeechServer(CTX);
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tools = await client.tools();
		const tool = tools.transcribe_audio as unknown as {
			execute: (input: unknown, opts: unknown) => Promise<unknown>;
		};
		return (await tool.execute(args, { toolCallId: 't1', messages: [] })) as {
			isError?: boolean;
			content?: { text?: string }[];
		};
	} finally {
		await client.close();
		await server.close();
	}
}

const resultText = (res: { content?: { text?: string }[] }) => res.content?.[0]?.text ?? '';

function seedSttModel() {
	const db = getDb();
	const provider = createProvider(db, {
		name: 'speaches',
		type: 'openai-compatible',
		baseUrl: 'http://speaches.local/v1'
	});
	const model = createModel(db, {
		providerId: provider.id,
		modelId: 'whisper',
		capabilities: ['transcription']
	});
	setRoleDefault(db, 'speech-to-text', model.id);
	return provider.id;
}

/** An uploaded audio file in conv-1, stored as the upload route stores it. */
async function seedAudio(name = 'memo.mp3', mime = 'audio/mpeg') {
	const db = getDb();
	db.prepare(
		`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role)
		 VALUES ('u1', 'A', 'u1@example.com', 0, 0, 0, 'user')`
	).run();
	const conv = createConversation(db, 'u1', { title: 't' });
	db.prepare('UPDATE conversations SET id = ? WHERE id = ?').run(CTX.conversationId, conv.id);
	const msg = createMessage(db, { conversationId: CTX.conversationId, role: 'user', parts: [] });
	const dir = path.resolve('.test-workspaces-speech', CTX.conversationId, 'attachments');
	await fsp.mkdir(dir, { recursive: true });
	const stored = `0b6a2c1e-7f3d-4c2a-9e1b-5d8f6a4c3b2e-${name}`;
	await fsp.writeFile(path.join(dir, stored), Buffer.from([1, 2, 3, 4]));
	const row = createAttachment(db, {
		kind: 'file',
		path: path.join(CTX.conversationId, 'attachments', stored),
		mime,
		sha256: 'x'
	});
	linkAttachmentsToMessage(db, msg.id, [row.id]);
	return row.id;
}

const realFetch = globalThis.fetch;

describe('speech server', () => {
	beforeEach(() => {
		closeDb();
	});

	afterEach(async () => {
		globalThis.fetch = realFetch;
		await fsp.rm(path.resolve('.test-workspaces-speech'), { recursive: true, force: true });
	});

	it('explains when no speech-to-text model is set', async () => {
		const res = await callTranscribe({ audio: 'anything' });
		expect(res.isError).toBe(true);
		expect(resultText(res)).toContain('Speech to text');
	});

	it('transcribes an uploaded audio file and logs the request', async () => {
		const providerId = seedSttModel();
		const id = await seedAudio();
		let sent: FormData | null = null;
		globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			sent = init?.body as FormData;
			return Response.json({ text: ' Buy milk and call Sam. ' });
		}) as typeof fetch;

		const res = await callTranscribe({ audio: `[attachment id: ${id}]`, language: 'en' });
		expect(res.isError).not.toBe(true);
		expect(resultText(res)).toBe('Buy milk and call Sam.');
		// The provider sees the original name and type, so it can tell the format.
		const file = sent!.get('file') as File;
		expect(file.name).toBe('memo.mp3');
		expect(file.type).toBe('audio/mpeg');
		expect(sent!.get('language')).toBe('en');

		const log = getDb()
			.prepare('SELECT purpose, source, conversation_id, provider_id, status FROM proxy_requests')
			.get();
		expect(log).toEqual({
			purpose: 'transcription',
			source: 'chat',
			conversation_id: 'conv-1',
			provider_id: providerId,
			status: 'complete'
		});
	});

	it('lists the audio attachments when the id does not match one', async () => {
		seedSttModel();
		const id = await seedAudio();
		const res = await callTranscribe({ audio: 'not-an-id' });
		expect(res.isError).toBe(true);
		expect(resultText(res)).toContain(id);
	});

	it('reports a provider failure as a tool error', async () => {
		seedSttModel();
		const id = await seedAudio();
		globalThis.fetch = vi.fn(async () =>
			Response.json({ error: { message: 'unsupported format' } }, { status: 400 })
		) as typeof fetch;
		const res = await callTranscribe({ audio: id });
		expect(res.isError).toBe(true);
		expect(resultText(res)).toBe('error: transcription failed: unsupported format');
	});
});
