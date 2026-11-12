import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { PushDispatcher, PushSender } from './dispatcher.js';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { openDatabase } = await import('../db/index.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { createAgent } = await import('../db/repo/agents.js');
const { listPushSubscriptions, upsertPushSubscription } =
	await import('../db/repo/push-subscriptions.js');
const { setUserSetting } = await import('../db/repo/user-settings.js');
const { createPushDispatcher, sendPushToUser, PUSH_DEDUPE_MS, PUSH_MAX_HOLD_MS, PUSH_RECHECK_MS } =
	await import('./dispatcher.js');
const { reportPresence, resetPresence } = await import('./presence.js');
const { DEFAULT_VAPID_SUBJECT, getVapidDetails, vapidSubject } = await import('./vapid.js');

type Db = ReturnType<typeof openDatabase>;

function seedUser(db: Db, id: string) {
	db.prepare(
		'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, 0, 0, \'user\')'
	).run(id, 'A', `${id}@example.com`);
}

function seedSession(db: Db, id: string, userId: string) {
	db.prepare(
		`INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
		 VALUES (?, '2999-01-01T00:00:00.000Z', ?, 0, 0, ?)`
	).run(id, `token-${id}`, userId);
}

function subscribe(db: Db, userId: string, n: number) {
	return upsertPushSubscription(db, userId, {
		sessionId: 's1',
		endpoint: `https://fcm.googleapis.com/fcm/send/${n}`,
		p256dh: `p${n}`,
		auth: `a${n}`
	});
}

const TEST_PAYLOAD = {
	title: 't',
	body: 'b',
	tag: 'x',
	url: '/',
	kind: 'test',
	createdAt: 0
} as const;

describe('push dispatcher', () => {
	let db: Db;
	let sender: Mock<PushSender>;
	let now: number;
	let dispatcher: PushDispatcher;
	/** Re-checks the dispatcher scheduled, run by hand with `advance`. */
	let scheduled: { at: number; run: () => Promise<void> }[];
	const advance = async (ms: number) => {
		now += ms;
		const due = scheduled.filter((t) => t.at <= now);
		scheduled = scheduled.filter((t) => t.at > now);
		for (const t of due) await t.run();
	};
	const payloads = () => sender.mock.calls.map((c) => JSON.parse(c[1] as string));

	beforeEach(() => {
		db = openDatabase(':memory:');
		seedUser(db, 'u1');
		seedSession(db, 's1', 'u1');
		sender = vi.fn<PushSender>(async () => ({ statusCode: 201 }));
		now = 1_000_000;
		scheduled = [];
		dispatcher = createPushDispatcher({
			db: () => db,
			sender,
			now: () => now,
			schedule: (run, ms) => {
				const task = { at: now + ms, run };
				scheduled.push(task);
				return () => (scheduled = scheduled.filter((t) => t !== task));
			}
		});
		resetPresence();
	});

	it('pushes a finished chat reply to every device of the user', async () => {
		subscribe(db, 'u1', 1);
		subscribe(db, 'u1', 2);
		const c = createConversation(db, 'u1', { title: 'Trip ideas' });
		await dispatcher.handle('u1', { type: 'chat.message_completed', conversationId: c.id });
		expect(sender).toHaveBeenCalledTimes(2);
		expect(payloads()[0]).toEqual({
			title: 'Trip ideas',
			body: 'New reply',
			tag: `chat:${c.id}`,
			url: `/chat/${c.id}`,
			kind: 'reply',
			createdAt: now
		});
		const options = sender.mock.calls[0][2] as { vapidDetails: unknown; urgency: string };
		expect(options.vapidDetails).toEqual(getVapidDetails(db));
		expect(options.urgency).toBe('high');
	});

	it('names the agent and sends questions as urgent', async () => {
		subscribe(db, 'u1', 1);
		const agent = createAgent(db, 'u1', {
			name: 'Inbox triage',
			systemPrompt: 'x',
			triggerType: 'manual'
		});
		const c = createConversation(db, 'u1', { agentId: agent.id });
		await dispatcher.handle('u1', {
			type: 'agent.run.awaiting_input',
			agentId: agent.id,
			runId: 'r1',
			conversationId: c.id,
			question: 'Archive these 12 newsletters?'
		});
		expect(payloads()[0]).toMatchObject({
			title: 'Inbox triage',
			body: 'Needs you: Archive these 12 newsletters?',
			kind: 'needs-you'
		});
		expect((sender.mock.calls[0][2] as { urgency: string }).urgency).toBe('high');
	});

	it('pushes when a coding task starts waiting for the user', async () => {
		subscribe(db, 'u1', 1);
		const c = createConversation(db, 'u1', { title: 'Fix tests' });
		db.prepare(
			`INSERT INTO coding_conversations (conversation_id, project_id, project_title,
			   provider_instance_id, model, runtime_mode, status, created_at, updated_at)
			 VALUES (?, 'p1', 'web', 'codex', 'gpt', 'full-access', 'awaiting_input', 0, 0)`
		).run(c.id);
		await dispatcher.handle('u1', { type: 'coding.task.awaiting_input', conversationId: c.id });
		expect(payloads()[0]).toMatchObject({
			title: 'Fix tests',
			body: 'Waiting for your input',
			kind: 'needs-you'
		});
	});

	it('respects the notification triggers of the user', async () => {
		subscribe(db, 'u1', 1);
		setUserSetting(db, 'u1', 'notificationTriggers', { replies: false });
		const c = createConversation(db, 'u1');
		await dispatcher.handle('u1', { type: 'chat.message_completed', conversationId: c.id });
		expect(sender).not.toHaveBeenCalled();
	});

	it('uses the push triggers, which can differ from the tab triggers', async () => {
		subscribe(db, 'u1', 1);
		setUserSetting(db, 'u1', 'notificationTriggers', { replies: true });
		setUserSetting(db, 'u1', 'pushTriggers', { replies: false });
		const c = createConversation(db, 'u1');
		await dispatcher.handle('u1', { type: 'chat.message_completed', conversationId: c.id });
		expect(sender).not.toHaveBeenCalled();
	});

	it('holds a notice while you are at Chatty and pushes it once you step away', async () => {
		subscribe(db, 'u1', 1);
		const c = createConversation(db, 'u1');
		// Busy in another chat on the PC when the reply lands.
		reportPresence('u1', 'pc', { path: '/chat/other', idleMs: 0 }, now);
		await dispatcher.handle('u1', { type: 'chat.message_completed', conversationId: c.id });
		expect(sender).not.toHaveBeenCalled();
		expect(dispatcher.heldCount()).toBe(1);
		// Still typing a minute later: keep holding.
		await advance(PUSH_RECHECK_MS);
		reportPresence('u1', 'pc', { path: '/chat/other', idleMs: 0 }, now);
		await advance(PUSH_RECHECK_MS);
		expect(sender).not.toHaveBeenCalled();
		// No input for two minutes: stepped away, push it.
		for (let i = 0; i < 4; i++) await advance(PUSH_RECHECK_MS);
		expect(payloads().map((p) => p.url)).toEqual([`/chat/${c.id}`]);
		expect(dispatcher.heldCount()).toBe(0);
	});

	it('pushes a reply to a chat you typed into and then left', async () => {
		subscribe(db, 'u1', 1);
		const c = createConversation(db, 'u1');
		const path = `/chat/${c.id}`;
		const typedAt = now;
		reportPresence('u1', 'pc', { path, idleMs: 0 }, now);
		now += 30_000; // the reply finishes, the chat still on screen
		reportPresence('u1', 'pc', { path, idleMs: 30_000 }, now);
		await dispatcher.handle('u1', { type: 'chat.message_completed', conversationId: c.id });
		expect(sender).not.toHaveBeenCalled();
		for (let i = 0; i < 4; i++) {
			// The tab keeps heartbeating, but nobody touches it.
			await advance(PUSH_RECHECK_MS);
			reportPresence('u1', 'pc', { path, idleMs: now - typedAt }, now);
		}
		expect(payloads().map((p) => p.url)).toEqual([path]);
	});

	it('still holds while the window is hidden behind another app', async () => {
		subscribe(db, 'u1', 1);
		const c = createConversation(db, 'u1');
		reportPresence('u1', 'pc', { path: null, idleMs: 0 }, now);
		await dispatcher.handle('u1', { type: 'chat.message_completed', conversationId: c.id });
		expect(dispatcher.heldCount()).toBe(1);
		expect(sender).not.toHaveBeenCalled();
	});

	it('drops a held notice once you looked at that chat, even after moving on', async () => {
		subscribe(db, 'u1', 1);
		const c = createConversation(db, 'u1');
		reportPresence('u1', 'pc', { path: '/chat/other', idleMs: 0 }, now);
		await dispatcher.handle('u1', { type: 'chat.message_completed', conversationId: c.id });
		expect(dispatcher.heldCount()).toBe(1);
		reportPresence('u1', 'pc', { path: `/chat/${c.id}`, idleMs: 0 }, now + 5_000);
		reportPresence('u1', 'pc', { path: '/chat/other', idleMs: 0 }, now + 10_000);
		for (let i = 0; i < 8; i++) await advance(PUSH_RECHECK_MS);
		expect(dispatcher.heldCount()).toBe(0);
		expect(sender).not.toHaveBeenCalled();
	});

	it('gives up on a notice held for too long', async () => {
		subscribe(db, 'u1', 1);
		const c = createConversation(db, 'u1');
		reportPresence('u1', 'pc', { path: '/', idleMs: 0 }, now);
		await dispatcher.handle('u1', { type: 'chat.message_completed', conversationId: c.id });
		for (let t = 0; t < PUSH_MAX_HOLD_MS; t += PUSH_RECHECK_MS) {
			reportPresence('u1', 'pc', { path: '/', idleMs: 0 }, now);
			await advance(PUSH_RECHECK_MS);
		}
		expect(dispatcher.heldCount()).toBe(0);
		for (let i = 0; i < 6; i++) await advance(PUSH_RECHECK_MS);
		expect(sender).not.toHaveBeenCalled();
	});

	it('drops a held question you answered meanwhile', async () => {
		subscribe(db, 'u1', 1);
		const agent = createAgent(db, 'u1', { name: 'A', systemPrompt: 'x', triggerType: 'manual' });
		const c = createConversation(db, 'u1', { agentId: agent.id });
		db.prepare(
			`INSERT INTO agent_runs (id, agent_id, user_id, trigger, status, conversation_id, started_at)
			 VALUES ('r1', ?, 'u1', 'chat', 'awaiting_input', ?, 0)`
		).run(agent.id, c.id);
		reportPresence('u1', 'pc', { path: '/', idleMs: 0 }, now);
		const event = {
			type: 'agent.run.awaiting_input',
			agentId: agent.id,
			runId: 'r1',
			conversationId: c.id,
			question: 'Go?'
		} as const;
		await dispatcher.handle('u1', event);
		db.prepare(`UPDATE agent_runs SET status = 'success' WHERE id = 'r1'`).run();
		for (let i = 0; i < 6; i++) await advance(PUSH_RECHECK_MS);
		expect(sender).not.toHaveBeenCalled();
	});

	it('tells the worker when the notice arose, so it can match a popup shown since', async () => {
		subscribe(db, 'u1', 1);
		const c = createConversation(db, 'u1');
		const arose = now;
		reportPresence('u1', 'pc', { path: '/chat/other', idleMs: 0 }, now);
		await dispatcher.handle('u1', { type: 'chat.message_completed', conversationId: c.id });
		for (let i = 0; i < 6; i++) await advance(PUSH_RECHECK_MS);
		expect(payloads()[0].createdAt).toBe(arose);
	});

	it('skips needs-you notices when that trigger is off, and settled coding tasks', async () => {
		subscribe(db, 'u1', 1);
		const c = createConversation(db, 'u1');
		db.prepare(
			`INSERT INTO coding_conversations (conversation_id, project_id, project_title,
			   provider_instance_id, model, runtime_mode, status, created_at, updated_at)
			 VALUES (?, 'p1', 'web', 'codex', 'gpt', 'full-access', 'awaiting_input', 0, 0)`
		).run(c.id);
		const event = { type: 'coding.task.awaiting_input', conversationId: c.id } as const;
		db.prepare('UPDATE conversations SET settled_at = 1 WHERE id = ?').run(c.id);
		await dispatcher.handle('u1', event);
		db.prepare('UPDATE conversations SET settled_at = NULL WHERE id = ?').run(c.id);
		setUserSetting(db, 'u1', 'notificationTriggers', { needsYou: false });
		await dispatcher.handle('u1', event);
		expect(sender).not.toHaveBeenCalled();
	});

	it('pushes a repeated notice once within the dedupe window', async () => {
		subscribe(db, 'u1', 1);
		const c = createConversation(db, 'u1');
		const event = { type: 'chat.message_completed', conversationId: c.id } as const;
		await dispatcher.handle('u1', event);
		await dispatcher.handle('u1', event);
		now += PUSH_DEDUPE_MS;
		await dispatcher.handle('u1', event);
		expect(sender).toHaveBeenCalledTimes(2);
	});

	it('ignores events that never notify, and users without devices', async () => {
		const c = createConversation(db, 'u1');
		await dispatcher.handle('u1', { type: 'chat.message_completed', conversationId: c.id });
		subscribe(db, 'u1', 1);
		await dispatcher.handle('u1', { type: 'chat.stream.started', conversationId: c.id });
		expect(sender).not.toHaveBeenCalled();
	});

	it('removes subscriptions the push service reports gone', async () => {
		subscribe(db, 'u1', 1);
		subscribe(db, 'u1', 2);
		sender.mockImplementation(async (s) => {
			if (s.endpoint.endsWith('/1')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
			return { statusCode: 201 };
		});
		const result = await sendPushToUser(db, 'u1', TEST_PAYLOAD, { sender });
		expect(result).toEqual({ sent: 1, removed: 1, failed: 0 });
		expect(listPushSubscriptions(db, 'u1').map((s) => s.endpoint)).toEqual([
			'https://fcm.googleapis.com/fcm/send/2'
		]);
	});

	it('never posts to a stored endpoint outside the push services', async () => {
		upsertPushSubscription(db, 'u1', {
			sessionId: 's1',
			endpoint: 'https://10.0.0.5/hook',
			p256dh: 'p',
			auth: 'a'
		});
		subscribe(db, 'u1', 1);
		const result = await sendPushToUser(db, 'u1', TEST_PAYLOAD, { sender });
		expect(result).toEqual({ sent: 1, removed: 1, failed: 0 });
		expect(sender.mock.calls.map((c) => c[0].endpoint)).toEqual([
			'https://fcm.googleapis.com/fcm/send/1'
		]);
		expect(listPushSubscriptions(db, 'u1')).toHaveLength(1);
	});

	it('does not hold outages, rate limits or network errors against a device', async () => {
		subscribe(db, 'u1', 1);
		for (const error of [
			Object.assign(new Error('Busy'), { statusCode: 503 }),
			Object.assign(new Error('Slow down'), { statusCode: 429 }),
			new Error('getaddrinfo ENOTFOUND')
		]) {
			sender.mockRejectedValueOnce(error);
			const result = await sendPushToUser(db, 'u1', TEST_PAYLOAD, { sender });
			expect(result).toEqual({ sent: 0, removed: 0, failed: 1 });
		}
		expect(listPushSubscriptions(db, 'u1')[0].failure_count).toBe(0);
	});

	it('counts a rejection of the subscription toward dropping it', async () => {
		subscribe(db, 'u1', 1);
		sender.mockRejectedValue(Object.assign(new Error('Forbidden'), { statusCode: 403 }));
		await sendPushToUser(db, 'u1', TEST_PAYLOAD, { sender });
		expect(listPushSubscriptions(db, 'u1')[0].failure_count).toBe(1);
	});
});

describe('vapid subject', () => {
	it('prefers VAPID_SUBJECT, then an https ORIGIN, then the project URL', () => {
		expect(vapidSubject({ VAPID_SUBJECT: 'mailto:me@example.com', ORIGIN: undefined })).toBe(
			'mailto:me@example.com'
		);
		expect(
			vapidSubject({ VAPID_SUBJECT: undefined, ORIGIN: 'https://box.tail1234.ts.net/app' })
		).toBe('https://box.tail1234.ts.net');
		expect(vapidSubject({ VAPID_SUBJECT: undefined, ORIGIN: 'http://localhost:3000' })).toBe(
			DEFAULT_VAPID_SUBJECT
		);
	});
});

describe('vapid keys', () => {
	it('generates a pair once and keeps it, with the private key encrypted', () => {
		const db = openDatabase(':memory:');
		const first = getVapidDetails(db);
		expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
		const row = db.prepare('SELECT * FROM push_vapid_keys').get() as {
			public_key: string;
			private_key_encrypted: string;
		};
		expect(row.public_key).toBe(first.publicKey);
		expect(row.private_key_encrypted).not.toContain(first.privateKey);
		expect(first.subject).toMatch(/^(mailto:|https:\/\/)/);
	});

	it('starts over with a new pair when the stored key cannot be decrypted', () => {
		const db = openDatabase(':memory:');
		db.prepare(
			`INSERT INTO push_vapid_keys (id, public_key, private_key_encrypted, created_at)
			 VALUES (1, 'old-public', 'not-decryptable', 0)`
		).run();
		const details = getVapidDetails(db);
		expect(details.publicKey).not.toBe('old-public');
		expect(details.privateKey.length).toBeGreaterThan(20);
	});
});
