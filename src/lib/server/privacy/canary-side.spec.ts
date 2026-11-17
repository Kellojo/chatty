/**
 * Egress canary rows for the side channels (PR 5): push notices, T3 title
 * sync, agent event dispatch and the browser's speech routes. Each row puts
 * CANARY into a private chat and checks it never leaves through that channel
 * (see canary-harness.ts for the recording providers).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

/** Commands Chatty sent to a (fake) T3 server. */
const t3Commands: Record<string, unknown>[] = [];
vi.doMock('../t3/client.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../t3/client.js')>()),
	connectT3: vi.fn(async () => ({
		closed: false,
		onClose: () => () => {},
		call: vi.fn(async (_tag: string, command: Record<string, unknown>) => {
			t3Commands.push(command);
			return {};
		}),
		close: vi.fn()
	}))
}));

const { getDb } = await import('../db/index.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { setRoleDefault } = await import('../db/repo/models.js');
const { createAgent } = await import('../db/repo/agents.js');
const { upsertPushSubscription } = await import('../db/repo/push-subscriptions.js');
const { createCodingEnvironment } = await import('../db/repo/coding-environments.js');
const coding = await import('../db/repo/coding-conversations.js');
const { createPushDispatcher } = await import('../push/dispatcher.js');
const { pushThreadState } = await import('../t3/thread-state.js');
const { emitAgentEvent } = await import('../agents/events.js');
const transcribeRoute = await import('../../../routes/api/speech/transcribe/+server.js');
const synthesizeRoute = await import('../../../routes/api/speech/synthesize/+server.js');
const { CANARY, createMapping } = await import('./fixtures.js');
const { useCanaryServer } = await import('./canary-harness.js');

const canary = useCanaryServer();
const { recorded, untrustedSaw, trustedSaw, expectNoLeak, privateChat } = canary;
let fx: typeof canary.fx;
beforeEach(() => {
	fx = canary.fx;
	t3Commands.length = 0;
});

/** Points a speech role at a mapping over `targets` (in order). */
function speechRole(
	role: 'speech-to-text' | 'text-to-speech',
	targets: { providerId: string; modelId: string }[]
) {
	const mapping = createMapping(getDb(), `${role}-mapping`, targets);
	setRoleDefault(getDb(), role, mapping.providerId);
}

function transcribe(fields: Record<string, string> = {}) {
	const form = new FormData();
	const audio = new TextEncoder().encode(`RIFF${CANARY}`);
	form.append('audio', new Blob([audio], { type: 'audio/webm' }), 'a.webm');
	for (const [key, value] of Object.entries(fields)) form.append(key, value);
	const request = new Request('http://localhost/api/speech/transcribe', {
		method: 'POST',
		body: form
	});
	return transcribeRoute.POST({
		request,
		locals: { user: { id: fx.userId } }
	} as never) as Promise<Response>;
}

/** The synthesize route's status (it throws SvelteKit errors). */
async function synthesize(body: Record<string, unknown> = {}): Promise<number> {
	const request = new Request('http://localhost/api/speech/synthesize', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ text: CANARY, ...body })
	});
	try {
		return (
			await synthesizeRoute.POST({
				request,
				locals: { user: { id: fx.userId } }
			} as never)
		).status;
	} catch (e) {
		return (e as { status: number }).status;
	}
}

describe('egress canary: side channels (PR 5)', () => {
	it('push: a private chat’s notice has a fixed title and body', async () => {
		const db = getDb();
		const c = createConversation(db, fx.userId, { title: CANARY, private: true });
		db.prepare(
			`INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
			 VALUES ('s1', '2999-01-01T00:00:00.000Z', 'token-s1', 0, 0, ?)`
		).run(fx.userId);
		upsertPushSubscription(db, fx.userId, {
			sessionId: 's1',
			endpoint: 'https://fcm.googleapis.com/fcm/send/1',
			p256dh: 'p',
			auth: 'a'
		});
		const sent: string[] = [];
		const dispatcher = createPushDispatcher({
			db: () => db,
			sender: async (_sub, payload) => {
				sent.push(payload);
				return { statusCode: 201 };
			}
		});
		await dispatcher.handle(fx.userId, { type: 'chat.message_completed', conversationId: c.id });
		expect(sent).toHaveLength(1);
		expect(JSON.parse(sent[0])).toMatchObject({ title: 'Private chat', body: 'New reply' });
		expect(sent[0]).not.toContain(CANARY);
	});

	it('T3 title sync: a private chat’s title is never sent', async () => {
		const db = getDb();
		const env = createCodingEnvironment(db, fx.userId, {
			name: 'T3',
			baseUrl: 'http://t3.test',
			token: 'token'
		});
		const c = createConversation(db, fx.userId, { title: CANARY, private: true });
		coding.createCodingConversation(db, {
			conversationId: c.id,
			environmentId: env.id,
			projectId: 'p1',
			projectTitle: 'Project',
			providerInstanceId: 'codex',
			model: 'gpt',
			runtimeMode: 'auto',
			workspaceMode: 'worktree',
			baseBranch: null
		});
		coding.updateCodingConversation(db, c.id, {
			threadId: 't1',
			remoteTitle: 'Old title',
			remoteSettled: false,
			remotePinned: false
		});
		await pushThreadState(db, fx.userId, [c.id]);
		expect(JSON.stringify(t3Commands)).not.toContain(CANARY);
		// The same chat made public would sync its title (so the row isn't vacuous).
		db.prepare('UPDATE conversations SET private = 0 WHERE id = ?').run(c.id);
		await pushThreadState(db, fx.userId, [c.id]);
		expect(t3Commands.map((cmd) => cmd.type)).toEqual(['thread.metadata.update']);
	});

	it('events: a private chat’s events never reach a public agent', async () => {
		const db = getDb();
		const agent = (name: string) =>
			createAgent(db, fx.userId, {
				name,
				systemPrompt: 'x',
				triggerType: 'event',
				triggerConfig: { event: 'chat.message_completed' }
			});
		const publicAgent = agent('public');
		const privateAgent = agent('private');
		db.prepare('UPDATE agents SET private = 1 WHERE id = ?').run(privateAgent.id);
		const c = privateChat(fx.trusted);
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('chat.message_completed', fx.userId, { conversationId: c.id }, db, runFn);
		expect(runFn.mock.calls.map((call) => call[0])).toEqual([privateAgent.id]);
		expect(runFn.mock.calls.map((call) => call[0])).not.toContain(publicAgent.id);
		expect(String(runFn.mock.calls[0][2])).not.toContain(CANARY);
	});

	it('transcribe route: no chat or private flag fails closed to trusted targets', async () => {
		speechRole('speech-to-text', [fx.untrusted, fx.trusted]);
		const res = await transcribe();
		expect(res.status).toBe(200);
		expect(trustedSaw().some((r) => r.body.includes(CANARY))).toBe(true);
		expect(untrustedSaw()).toEqual([]);
	});

	it('transcribe route: a private chat’s recording only reaches trusted targets', async () => {
		speechRole('speech-to-text', [fx.untrusted, fx.trusted]);
		const c = privateChat(fx.trusted);
		// The client claiming "not private" doesn't override the chat's flag.
		expect((await transcribe({ conversationId: c.id, private: 'false' })).status).toBe(200);
		expect(trustedSaw().some((r) => r.body.includes(CANARY))).toBe(true);
		expectNoLeak();
	});

	it('transcribe route: only untrusted targets is a 403 and nothing is sent', async () => {
		speechRole('speech-to-text', [fx.untrusted]);
		const res = await transcribe();
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: 'private_data_blocked' });
		// Nor with a client-chosen untrusted model.
		expect((await transcribe({ private: 'true', ...fx.untrusted })).status).toBe(403);
		expect(recorded).toEqual([]);
	});

	it('synthesize route: no chat or private flag fails closed to trusted targets', async () => {
		speechRole('text-to-speech', [fx.untrusted, fx.trusted]);
		expect(await synthesize()).toBe(200);
		expect(trustedSaw().some((r) => r.body.includes(CANARY))).toBe(true);
		expect(untrustedSaw()).toEqual([]);
	});

	it('synthesize route: a private chat’s text only reaches trusted targets', async () => {
		speechRole('text-to-speech', [fx.untrusted, fx.trusted]);
		const c = privateChat(fx.trusted);
		expect(await synthesize({ conversationId: c.id, private: false })).toBe(200);
		expect(trustedSaw().some((r) => r.body.includes(CANARY))).toBe(true);
		expectNoLeak();
	});

	it('synthesize route: only untrusted targets is a 403 and nothing is sent', async () => {
		speechRole('text-to-speech', [fx.untrusted]);
		expect(await synthesize()).toBe(403);
		expect(await synthesize({ private: true })).toBe(403);
		expect(recorded).toEqual([]);
	});
});
