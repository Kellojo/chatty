/**
 * The egress canary test: the guarantee behind private data.
 *
 * Two providers point at a local server that records every request body: one
 * trusted with private data, one not. Private fixtures contain CANARY. Each
 * row drives one path by which data leaves Chatty and asserts that the
 * untrusted provider never receives the canary. Most rows also check the
 * trusted one did get the call, so a row can't pass by doing nothing.
 *
 * Rows still marked `todo` are paths a later step closes; a new path gets a
 * row here before it ships.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.CHAT_COMPACT_TOKENS = '1000';
process.env.CHAT_COMPACT_KEEP_MESSAGES = '4';

const { closeDb, getDb } = await import('../db/index.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { createMessage } = await import('../db/repo/messages.js');
const { createAgent } = await import('../db/repo/agents.js');
const { createAgentRun } = await import('../db/repo/agent-runs.js');
const { handleChatRequest } = await import('../chat/service.js');
const { generateConversationTitle } = await import('../chat/title.js');
const { maybeCompactConversation } = await import('../chat/compact.js');
const { createStepSummarizer } = await import('../agents/stepCompaction.js');
const { transcribeWithFallbacks } = await import('../speech/transcriber.js');
const { synthesizeWithFallbacks } = await import('../speech/synthesizer.js');
const { listVoices } = await import('../speech/voices.js');
const { forwardDecisions } = await import('../decisions/handler.js');
const { resolveImageModel } = await import('../llm/registry.js');
const { PrivateDataBlockedError } = await import('./policy.js');
const { CANARY, createMapping, markConversationPrivate, seedPrivacyFixture, setRole } =
	await import('./fixtures.js');

// --- the recording server ---------------------------------------------------

interface Recorded {
	kind: 'trusted' | 'untrusted';
	path: string;
	body: string;
}

const recorded: Recorded[] = [];
let server: http.Server;
let base = '';

const completion = (stream: boolean) =>
	stream
		? [
				{ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] },
				{
					choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
					usage: { prompt_tokens: 1, completion_tokens: 1 }
				}
			]
				.map((c) => `data: ${JSON.stringify({ id: 'x', created: 0, model: 'm', ...c })}\n\n`)
				.join('') + 'data: [DONE]\n\n'
		: JSON.stringify({
				id: 'x',
				created: 0,
				model: 'm',
				choices: [
					{ index: 0, message: { role: 'assistant', content: 'A summary.' }, finish_reason: 'stop' }
				],
				usage: { prompt_tokens: 1, completion_tokens: 1 }
			});

function respond(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
	const url = req.url ?? '';
	if (url.endsWith('/chat/completions')) {
		const stream = /"stream":\s*true/.test(body);
		res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
		res.end(completion(stream));
	} else if (url.endsWith('/audio/transcriptions')) {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ text: 'transcript' }));
	} else if (url.endsWith('/audio/speech')) {
		res.writeHead(200, { 'content-type': 'audio/mpeg' });
		res.end(Buffer.from([1, 2, 3]));
	} else if (url.endsWith('/audio/voices')) {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ voices: ['alloy'] }));
	} else if (url.endsWith('/decisions')) {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ decisions: [] }));
	} else if (url.endsWith('/images/generations')) {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }));
	} else {
		res.writeHead(404);
		res.end();
	}
}

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			// Binary bodies (audio uploads) are searched as latin1, which keeps ASCII intact.
			const body = Buffer.concat(chunks).toString('latin1');
			const kind = (req.url ?? '').startsWith('/trusted/') ? 'trusted' : 'untrusted';
			recorded.push({ kind, path: req.url ?? '', body });
			respond(req, res, body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

let fx: ReturnType<typeof seedPrivacyFixture>;

beforeEach(() => {
	closeDb();
	recorded.length = 0;
	const db = getDb();
	fx = seedPrivacyFixture(db, (kind) => `${base}/${kind}/v1`);
	// The canary rows test model and speech egress; tools have their own rows.
	db.prepare('UPDATE mcp_servers SET enabled = 0').run();
});

const untrustedSaw = () => recorded.filter((r) => r.kind === 'untrusted');
const trustedSaw = () => recorded.filter((r) => r.kind === 'trusted');
const leaked = () => untrustedSaw().filter((r) => r.body.includes(CANARY));

/** The row's invariant: the canary never reached the untrusted provider. */
function expectNoLeak(): void {
	expect(leaked().map((r) => r.path)).toEqual([]);
}

/** A private conversation on `model` whose history holds the canary. */
function privateChat(model: { providerId: string; modelId: string }, messages = 2) {
	const db = getDb();
	const c = createConversation(db, fx.userId, { title: 'secret', ...model });
	markConversationPrivate(db, c.id);
	for (let i = 0; i < messages; i++) {
		createMessage(db, {
			conversationId: c.id,
			role: i % 2 === 0 ? 'user' : 'assistant',
			parts: [{ type: 'text', text: `${CANARY} ${'x'.repeat(400)}` }]
		});
	}
	return c;
}

async function drain(res: Response): Promise<void> {
	await res.text();
	// The stream's onEnd persists after the body is done.
	await new Promise((r) => setTimeout(r, 50));
}

const privacyOf = (conversationId: string) => ({ tainted: false, conversationId });

// --- rows -------------------------------------------------------------------

describe('egress canary: model and speech calls (PR 3)', () => {
	it('chat turn: a private chat on an untrusted model is refused before any request', async () => {
		const c = privateChat(fx.untrusted);
		await expect(
			handleChatRequest(fx.userId, {
				conversationId: c.id,
				message: { id: 'm-new', role: 'user', parts: [{ type: 'text', text: CANARY }] }
			})
		).rejects.toThrow(/private/i);
		expect(untrustedSaw()).toEqual([]);
	});

	it('chat turn: a private chat on a trusted model reaches it', async () => {
		const c = privateChat(fx.trusted);
		await drain(
			await handleChatRequest(fx.userId, {
				conversationId: c.id,
				message: { id: 'm-new', role: 'user', parts: [{ type: 'text', text: CANARY }] }
			})
		);
		expect(trustedSaw().some((r) => r.body.includes(CANARY))).toBe(true);
		expectNoLeak();
	});

	it('fallback: a mapping never falls back to an untrusted target', async () => {
		const db = getDb();
		const mapping = createMapping(db, 'mixed', [fx.untrusted, fx.trusted]);
		const c = privateChat(mapping);
		await drain(
			await handleChatRequest(fx.userId, {
				conversationId: c.id,
				message: { id: 'm-new', role: 'user', parts: [{ type: 'text', text: CANARY }] }
			})
		);
		expect(untrustedSaw()).toEqual([]);
		expect(trustedSaw().length).toBeGreaterThan(0);
	});

	it("title: an untrusted title role falls back to the chat's trusted model", async () => {
		const db = getDb();
		setRole(db, 'title', fx.untrusted);
		const c = privateChat(fx.trusted);
		await generateConversationTitle(c.id, fx.userId, fx.trusted, CANARY, CANARY, privacyOf(c.id));
		expect(trustedSaw().some((r) => r.body.includes(CANARY))).toBe(true);
		expectNoLeak();
	});

	it('title: with no trusted model at all, a placeholder title and no request', async () => {
		const db = getDb();
		setRole(db, 'title', fx.untrusted);
		const c = privateChat(fx.untrusted);
		await generateConversationTitle(c.id, fx.userId, fx.untrusted, CANARY, CANARY, privacyOf(c.id));
		expect(recorded).toEqual([]);
		const row = db.prepare('SELECT title FROM conversations WHERE id = ?').get(c.id) as {
			title: string;
		};
		expect(row.title).toMatch(/^Private chat/);
	});

	it('compaction: an untrusted compaction role is skipped for a private chat', async () => {
		const db = getDb();
		setRole(db, 'compaction', fx.untrusted);
		const c = privateChat(fx.trusted, 20);
		await maybeCompactConversation(c, fx.userId, fx.trusted, privacyOf(c.id));
		expect(trustedSaw().some((r) => r.body.includes(CANARY))).toBe(true);
		expectNoLeak();
	});

	it('step compaction: summaries of a private run stay on trusted models', async () => {
		const db = getDb();
		setRole(db, 'compaction', fx.untrusted);
		const c = privateChat(fx.trusted);
		const summarize = createStepSummarizer({
			db,
			userId: fx.userId,
			conversationId: c.id,
			fallback: fx.trusted,
			privacy: privacyOf(c.id)
		});
		await summarize({ transcript: CANARY, previous: null });
		expect(trustedSaw().some((r) => r.body.includes(CANARY))).toBe(true);
		expectNoLeak();
	});

	it("step compaction: a private agent's run counts as private", async () => {
		const db = getDb();
		setRole(db, 'compaction', fx.untrusted);
		const agent = createAgent(db, fx.userId, {
			name: 'a',
			systemPrompt: 'x',
			triggerType: 'manual'
		});
		db.prepare('UPDATE agents SET private = 1 WHERE id = ?').run(agent.id);
		const run = createAgentRun(db, { agentId: agent.id, userId: fx.userId, trigger: 'manual' });
		const c = createConversation(db, fx.userId, { ...fx.untrusted });
		const summarize = createStepSummarizer({
			db,
			userId: fx.userId,
			conversationId: c.id,
			fallback: fx.untrusted,
			privacy: { tainted: false, conversationId: c.id, agentRunId: run.id }
		});
		// No trusted model to summarize with: the steps are only truncated.
		expect(await summarize({ transcript: CANARY, previous: null })).toBeNull();
		expect(recorded).toEqual([]);
	});

	it('speech to text: a private recording only reaches trusted targets', async () => {
		const audio = new TextEncoder().encode(`RIFF${CANARY}`).buffer as ArrayBuffer;
		await transcribeWithFallbacks(audio, [fx.untrusted, fx.trusted], { tainted: true });
		expect(trustedSaw().some((r) => r.body.includes(CANARY))).toBe(true);
		expectNoLeak();
		await expect(transcribeWithFallbacks(audio, [fx.untrusted], { tainted: true })).rejects.toThrow(
			/private/i
		);
		expectNoLeak();
	});

	it('text to speech: private text only reaches trusted targets', async () => {
		await synthesizeWithFallbacks(CANARY, [fx.untrusted, fx.trusted], { tainted: true });
		expect(trustedSaw().some((r) => r.body.includes(CANARY))).toBe(true);
		expectNoLeak();
		await expect(
			synthesizeWithFallbacks(CANARY, [fx.untrusted], { tainted: true })
		).rejects.toThrow(/private/i);
		expectNoLeak();
	});

	it('voices: listing voices sends no content', async () => {
		await listVoices(getDb(), fx.untrusted);
		expect(untrustedSaw().every((r) => r.body === '')).toBe(true);
		expectNoLeak();
	});

	it('decisions: a trusted-only mapping never reaches an untrusted target', async () => {
		const db = getDb();
		const mapping = createMapping(db, 'decide', [fx.untrusted, fx.trusted]);
		db.prepare('UPDATE model_mappings SET trusted_only = 1 WHERE id = ?').run(mapping.id);
		const request = {
			model: 'decide',
			input: CANARY,
			questions: [{ id: 'q', question: 'yes?', type: 'boolean' }]
		} as never;
		await forwardDecisions(request, { tainted: false });
		expect(trustedSaw().some((r) => r.body.includes(CANARY))).toBe(true);
		expectNoLeak();
		// Private input on a plain mapping is filtered the same way.
		const plain = createMapping(db, 'plain', [fx.untrusted]);
		await expect(
			forwardDecisions({ ...(request as object), model: plain.modelId } as never, { tainted: true })
		).rejects.toThrow(PrivateDataBlockedError);
		expectNoLeak();
	});

	it('image: a private context cannot build an untrusted image model', () => {
		expect(() => resolveImageModel(fx.untrusted, { tainted: true })).toThrow(
			PrivateDataBlockedError
		);
		expect(() => resolveImageModel(fx.trusted, { tainted: true })).not.toThrow();
		expect(recorded).toEqual([]);
	});
});

describe('egress canary: private chats end to end (PR 4)', () => {
	it.todo('agent result: a private run result never reaches an untrusted caller');
	it.todo('subagent: a subagent of a private parent stays private');
	it.todo('coding proposal: blocked from a tainted context');
	it.todo('hand-off: refused for a private chat');
	it.todo('gateway: read_chat never returns a private chat');
	it.todo('tools: web fetch, fs_curl, weather and web search are refused once tainted');
});

describe('egress canary: side channels (PR 5)', () => {
	it.todo('push payload: a private chat gets a fixed title and body');
	it.todo('T3 title sync: skips private conversations');
	it.todo('event dispatch: events from private chats only reach private agents');
	it.todo('transcribe and synthesize routes: fail closed without a conversation');
});

describe('egress canary: private memory (PR 6)', () => {
	it.todo('memory search: an untrusted turn never sees a private concept');
	it.todo('gateway: search_memory never returns a private concept');
	it.todo('memory extraction: the public pass never reads a private chat');
	it.todo('memory cleanup: an untrusted memory model skips private concepts');
});
