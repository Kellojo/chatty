/**
 * The egress canary test: the guarantee behind private data.
 *
 * Two providers point at a local server that records every request body: one
 * trusted with private data, one not. Private fixtures contain CANARY. Each
 * row drives one path by which data leaves Chatty and asserts that the
 * untrusted provider never receives the canary. Most rows also check the
 * trusted one did get the call, so a row can't pass by doing nothing.
 *
 * The harness is in canary-harness.ts; other areas have their own
 * canary-*.spec.ts. A new egress path gets a row before it ships.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.CHAT_COMPACT_TOKENS = '1000';
process.env.CHAT_COMPACT_KEEP_MESSAGES = '4';

const { getDb } = await import('../db/index.js');
const { createConversation } = await import('../db/repo/conversations.js');
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
const { CANARY, createMapping, setRole } = await import('./fixtures.js');
const { useCanaryServer } = await import('./canary-harness.js');

const canary = useCanaryServer();
const { recorded, untrustedSaw, trustedSaw, expectNoLeak, privateChat, drain } = canary;
let fx: typeof canary.fx;
beforeEach(() => {
	fx = canary.fx;
});

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
