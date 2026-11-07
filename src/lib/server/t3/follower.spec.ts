import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

type Handlers = { onValue: (value: unknown) => void; onEnd: (error: Error | null) => void };

class FakeConnection {
	closed = false;
	readonly streams: Handlers[] = [];
	readonly cancels = vi.fn();
	private readonly closeListeners: ((error: Error) => void)[] = [];
	onClose(listener: (error: Error) => void) {
		this.closeListeners.push(listener);
		return () => {};
	}
	stream(_tag: string, _payload: unknown, handlers: Handlers) {
		this.streams.push(handlers);
		return {
			cancel: () => {
				this.cancels();
				this.streams.splice(this.streams.indexOf(handlers), 1);
			}
		};
	}
	async call() {
		return {};
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		const error = new Error('Connection closed');
		for (const handlers of this.streams.splice(0)) handlers.onEnd(error);
		for (const listener of this.closeListeners) listener(error);
	}
}

let failConnect = true;
let lastConnection: FakeConnection | null = null;
const connectT3 = vi.fn(async () => {
	if (failConnect) throw new Error('ECONNREFUSED');
	lastConnection = new FakeConnection();
	return lastConnection;
});
const { T3ClientError } = await import('./client.js');
vi.doMock('./client.js', () => ({
	connectT3,
	t3HttpGet: vi.fn(async () => ({ projects: [] })),
	T3ClientError
}));
vi.doMock('../events/bus.js', () => ({ publishServerEvent: vi.fn() }));
vi.doMock('./thread-state.js', () => ({
	queueThreadStatePush: vi.fn(),
	reconcileThreadState: vi.fn(() => false),
	remoteThreadState: vi.fn(() => ({}))
}));

const { getDb, closeDb } = await import('../db/index.js');
const { createConversation } = await import('../db/repo/conversations.js');
const coding = await import('../db/repo/coding-conversations.js');
const { createCodingEnvironment } = await import('../db/repo/coding-environments.js');
const { ensureFollower, getFollower, stopAllCodingFollowers, GAVE_UP_ERROR } =
	await import('./follower.js');

let conversationId: string;
let follower: ReturnType<typeof ensureFollower>;

beforeEach(() => {
	vi.useFakeTimers();
	failConnect = true;
	lastConnection = null;
	closeDb();
	const db = getDb();
	db.prepare(
		`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'u1', 'u1@example.com', 0, 0, 0, 'user')`
	).run();
	const env = createCodingEnvironment(db, 'u1', {
		name: 'T3',
		baseUrl: 'http://t3.test',
		token: 'token'
	});
	conversationId = createConversation(db, 'u1', { kind: 'chat', mode: 'agent', title: 'Task' }).id;
	coding.createCodingConversation(db, {
		conversationId,
		environmentId: env.id,
		projectId: 'p1',
		projectTitle: 'Chatty',
		providerInstanceId: 'codex',
		model: 'gpt-5',
		runtimeMode: 'full-access',
		workspaceMode: 'worktree',
		baseBranch: null
	});
	coding.updateCodingConversation(db, conversationId, { threadId: 't1' });
	follower = ensureFollower({ conversationId, userId: 'u1', env, threadId: 't1' });
});

afterEach(() => {
	stopAllCodingFollowers();
	vi.useRealTimers();
});

const seconds = (s: number) => vi.advanceTimersByTimeAsync(s * 1000);
const lastError = () => coding.getCodingConversation(getDb(), conversationId)?.last_error;

describe('CodingFollower reconnects', () => {
	it('gives up after repeated failed connects and surfaces the error', async () => {
		void follower.follow();
		// Attempts at 0, 2, 6, 14, 30, 62, 122, 182 s (backoff capped at 60 s).
		await seconds(181);
		expect(getFollower(conversationId)).toBe(follower);
		expect(lastError()).toBe('Lost connection to the coding environment');
		await seconds(2);
		expect(getFollower(conversationId)).toBeUndefined();
		expect(lastError()).toBe(GAVE_UP_ERROR);
		const calls = connectT3.mock.calls.length;
		await seconds(600);
		expect(connectT3.mock.calls.length).toBe(calls);
	});

	it('gives up on a server that accepts the subscription but never sends a snapshot', async () => {
		failConnect = false;
		void follower.follow();
		// Each attempt waits 30 s for the snapshot, then backs off.
		await seconds(400);
		expect(getFollower(conversationId)).toBe(follower);
		expect(lastConnection!.cancels).toHaveBeenCalledTimes(7);
		await seconds(30);
		expect(getFollower(conversationId)).toBeUndefined();
		expect(lastError()).toBe(GAVE_UP_ERROR);
	});

	it('starts counting again after a snapshot, so transient blips keep reconnecting', async () => {
		void follower.follow();
		await seconds(30); // 5 failed attempts
		failConnect = false;
		await seconds(32);
		const conn = lastConnection!;
		conn.streams[0].onValue({ kind: 'snapshot', snapshotSequence: 1, projection: {} });
		await seconds(1);
		expect(lastError()).toBeNull();
		failConnect = true;
		conn.close();
		// Without the reset, the 8th failure would come within seconds.
		await seconds(150);
		expect(getFollower(conversationId)).toBe(follower);
		await seconds(100);
		expect(getFollower(conversationId)).toBeUndefined();
	});

	it('keeps reconnecting while a Chatty turn is live', async () => {
		follower.beginTurn('m1');
		void follower.follow();
		await seconds(900);
		expect(getFollower(conversationId)).toBe(follower);
		expect(connectT3.mock.calls.length).toBeGreaterThan(10);
	});
});

describe('CodingFollower stop', () => {
	it('ends a live reply locally and never reconnects or interrupts the remote run', async () => {
		const { abortStream, getStreamState, hasActiveStream } = await import('../chat/streams.js');
		failConnect = false;
		follower.beginTurn('m1');
		await follower.follow();
		const conn = lastConnection!;
		const callSpy = vi.spyOn(conn, 'call');
		expect(hasActiveStream(conversationId)).toBe(true);

		follower.stop('The coding environment was removed');

		expect(hasActiveStream(conversationId)).toBe(false);
		expect(getStreamState(conversationId)).toBeNull();
		expect(conn.closed).toBe(true);
		// Nothing left to abort, and no interrupt or new socket for the old credentials.
		expect(abortStream(conversationId)).toBe(false);
		const connects = connectT3.mock.calls.length;
		await seconds(600);
		expect(connectT3.mock.calls.length).toBe(connects);
		expect(callSpy).not.toHaveBeenCalled();
	});
});

describe('CodingFollower message ids', () => {
	it('scopes a reply id that another conversation following the thread already holds', async () => {
		const { createMessage, getMessage } = await import('../db/repo/messages.js');
		const db = getDb();
		db.prepare(
			`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u2', 'u2', 'u2@example.com', 0, 0, 0, 'user')`
		).run();
		const other = createConversation(db, 'u2', { kind: 'chat', mode: 'agent', title: 'Task' }).id;
		createMessage(db, {
			id: 'm1:reply',
			conversationId: other,
			role: 'assistant',
			parts: [{ type: 'text', text: 'theirs' }],
			status: 'complete'
		});

		follower.beginTurn('m1');

		expect(getMessage(db, 'm1:reply')).toMatchObject({
			conversation_id: other,
			status: 'complete'
		});
		expect(getMessage(db, `${conversationId}:m1:reply`)).toMatchObject({
			conversation_id: conversationId,
			status: 'partial'
		});
		// Stays on the scoped id once it has it, even when the plain id frees up.
		db.prepare('DELETE FROM messages WHERE id = ?').run('m1:reply');
		follower.beginTurn('m1');
		expect(getMessage(db, 'm1:reply')).toBeUndefined();
	});

	it('keeps the plain id when no other conversation holds it', async () => {
		const { getMessage } = await import('../db/repo/messages.js');
		follower.beginTurn('m1');
		expect(getMessage(getDb(), 'm1:reply')).toMatchObject({ conversation_id: conversationId });
	});
});
