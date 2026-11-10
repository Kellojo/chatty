import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

type Handlers = { onValue: (value: unknown) => void; onEnd: (error: Error | null) => void };

class FakeConnection {
	closed = false;
	readonly streams: Handlers[] = [];
	readonly payloads: unknown[] = [];
	readonly cancels = vi.fn();
	private readonly closeListeners: ((error: Error) => void)[] = [];
	onClose(listener: (error: Error) => void) {
		this.closeListeners.push(listener);
		return () => {};
	}
	stream(_tag: string, payload: unknown, handlers: Handlers) {
		this.payloads.push(payload);
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
const {
	ensureFollower,
	getFollower,
	stopAllCodingFollowers,
	GAVE_UP_ERROR,
	RUN_GONE_ERROR,
	UNBOUND_TURN_ERROR
} = await import('./follower.js');

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

	it('keeps reconnecting while a Chatty turn is live, but not forever', async () => {
		const { getMessage } = await import('../db/repo/messages.js');
		const { hasActiveStream } = await import('../chat/streams.js');
		follower.beginTurn('m1');
		void follower.follow();
		await seconds(500);
		expect(getFollower(conversationId)).toBe(follower);
		expect(connectT3.mock.calls.length).toBeGreaterThan(10);
		// The turn never got a run: it ends with an error, then the follower gives up.
		await seconds(300);
		expect(hasActiveStream(conversationId)).toBe(false);
		expect(getFollower(conversationId)).toBeUndefined();
		expect(getMessage(getDb(), 'm1:reply')).toMatchObject({
			status: 'failed',
			error: UNBOUND_TURN_ERROR
		});
	});

	it('gives up eventually on a live turn whose run is bound', async () => {
		const { getMessage } = await import('../db/repo/messages.js');
		failConnect = false;
		follower.beginTurn('m1');
		await follower.follow();
		lastConnection!.streams[0].onValue(runSnapshot('running'));
		await seconds(1);
		failConnect = true;
		lastConnection!.close();
		await seconds(600);
		expect(getFollower(conversationId)).toBe(follower);
		await seconds(900);
		expect(getFollower(conversationId)).toBeUndefined();
		expect(getMessage(getDb(), 'm1:reply')).toMatchObject({
			status: 'failed',
			error: GAVE_UP_ERROR
		});
	});

	it('does not record an error when stopped while connecting', async () => {
		let resolve!: (conn: FakeConnection) => void;
		connectT3.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
		const following = follower.follow();
		follower.stop();
		resolve(new FakeConnection());
		await following;
		expect(lastError()).toBeNull();
	});

	it('gives up at once when the token is rejected on connect', async () => {
		connectT3.mockRejectedValueOnce(new T3ClientError('Token rejected', 'unauthorized'));
		await follower.follow();
		const calls = connectT3.mock.calls.length;
		expect(getFollower(conversationId)).toBeUndefined();
		expect(lastError()).toBe('Token rejected');
		await seconds(600);
		expect(connectT3.mock.calls.length).toBe(calls);
	});

	it('gives up at once when the subscription is rejected as unauthorized', async () => {
		failConnect = false;
		await follower.follow();
		const calls = connectT3.mock.calls.length;
		lastConnection!.streams[0].onEnd(new T3ClientError('Token rejected', 'unauthorized'));
		expect(getFollower(conversationId)).toBeUndefined();
		await seconds(600);
		expect(connectT3.mock.calls.length).toBe(calls);
	});
});

const runSnapshot = (status: string, sequence = 1, runs = true) => ({
	kind: 'snapshot',
	snapshotSequence: sequence,
	projection: {
		thread: { id: 't1' },
		runs: runs
			? [
					{
						id: 'run-1',
						ordinal: 1,
						status,
						userMessageId: 'm1',
						requestedAt: '2026-11-07T10:00:00.000Z'
					}
				]
			: [],
		turnItems: []
	}
});

describe('CodingFollower live turn bounds', () => {
	it('ends a live turn whose run disappears from the thread', async () => {
		const { getMessage } = await import('../db/repo/messages.js');
		const { hasActiveStream } = await import('../chat/streams.js');
		failConnect = false;
		follower.beginTurn('m1');
		await follower.follow();
		const stream = lastConnection!.streams[0];
		stream.onValue(runSnapshot('running'));
		await seconds(1);
		expect(hasActiveStream(conversationId)).toBe(true);

		stream.onValue(runSnapshot('running', 2, false));
		await seconds(1);

		expect(hasActiveStream(conversationId)).toBe(false);
		expect(getMessage(getDb(), 'm1:reply')).toMatchObject({
			status: 'failed',
			error: RUN_GONE_ERROR
		});
	});

	it('follows the active run when T3 adds a follow-up message to it', async () => {
		const { getMessage } = await import('../db/repo/messages.js');
		const { getStreamState, hasActiveStream } = await import('../chat/streams.js');
		failConnect = false;
		follower.beginTurn('m1');
		await follower.follow();
		const stream = lastConnection!.streams[0];
		stream.onValue(runSnapshot('running'));
		await seconds(1);

		// Sent while run-1 is active: T3 adds m2 to run-1 instead of starting a run.
		follower.beginTurn('m2');
		const joined = runSnapshot('running', 2);
		joined.projection.turnItems = [
			{
				id: 'turn-item:message:m2',
				runId: 'run-1',
				messageId: 'm2',
				ordinal: 5,
				type: 'user_message',
				status: 'completed',
				text: 'next'
			}
		] as never[];
		stream.onValue(joined);
		await seconds(1);

		expect(getMessage(getDb(), 'm2:reply')).toBeUndefined();
		expect(hasActiveStream(conversationId)).toBe(true);
		expect(getStreamState(conversationId)?.chunks[0]).toEqual({
			type: 'start',
			messageId: 'm1:reply'
		});

		stream.onValue(runSnapshot('completed', 3));
		await seconds(1);
		expect(hasActiveStream(conversationId)).toBe(false);
	});

	it('does not let a pending idle stop end a new turn', async () => {
		const { hasActiveStream } = await import('../chat/streams.js');
		failConnect = false;
		await follower.follow();
		lastConnection!.streams[0].onValue(runSnapshot('completed'));
		await seconds(290); // idle stop armed at the first render, due at ~300 s
		follower.beginTurn('m2');
		await seconds(60);
		expect(getFollower(conversationId)).toBe(follower);
		expect(hasActiveStream(conversationId)).toBe(true);
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
		expect(conn.cancels).toHaveBeenCalled();
		// Nothing left to abort, and no interrupt or new socket for the old credentials.
		expect(abortStream(conversationId)).toBe(false);
		const connects = connectT3.mock.calls.length;
		await seconds(600);
		expect(connectT3.mock.calls.length).toBe(connects);
		// The shared socket closes once nobody uses it.
		expect(conn.closed).toBe(true);
		expect(callSpy).not.toHaveBeenCalled();
		const { getMessage } = await import('../db/repo/messages.js');
		expect(getMessage(getDb(), 'm1:reply')).toMatchObject({
			status: 'failed',
			error: 'The coding environment was removed'
		});
	});
});

describe('CodingFollower shared socket and resume', () => {
	it('shares one socket between the followers of an environment', async () => {
		const { getCodingEnvironment } = await import('../db/repo/coding-environments.js');
		const db = getDb();
		const row = coding.getCodingConversation(db, conversationId)!;
		const env = getCodingEnvironment(db, 'u1', row.environment_id!)!;
		const otherId = createConversation(db, 'u1', { kind: 'chat', mode: 'agent', title: 'B' }).id;
		coding.createCodingConversation(db, {
			conversationId: otherId,
			environmentId: env.id,
			projectId: 'p1',
			projectTitle: 'Chatty',
			providerInstanceId: 'codex',
			model: 'gpt-5',
			runtimeMode: 'full-access',
			workspaceMode: 'worktree',
			baseBranch: null
		});
		failConnect = false;
		const calls = connectT3.mock.calls.length;
		const other = ensureFollower({ conversationId: otherId, userId: 'u1', env, threadId: 't2' });
		await Promise.all([follower.follow(), other.follow()]);
		expect(connectT3.mock.calls.length).toBe(calls + 1);
		expect(lastConnection!.streams).toHaveLength(2);
	});

	it('resubscribes from the last sequence it saw after a reconnect', async () => {
		failConnect = false;
		await follower.follow();
		const first = lastConnection!;
		expect(first.payloads[0]).toEqual({ threadId: 't1' });
		first.streams[0].onValue(runSnapshot('running', 7));
		await seconds(1);
		first.close();
		await seconds(5);
		const second = lastConnection!;
		expect(second).not.toBe(first);
		expect(second.payloads[0]).toEqual({
			threadId: 't1',
			afterSequence: 7,
			requestCompletionMarker: true
		});
		second.streams[0].onValue({ kind: 'synchronized' });
		await seconds(60);
		// Caught up: no snapshot timeout cancelled it.
		expect(second.cancels).not.toHaveBeenCalled();
		expect(getFollower(conversationId)).toBe(follower);
	});

	it('falls back to a full snapshot when a resumed subscription stays silent', async () => {
		failConnect = false;
		await follower.follow();
		lastConnection!.streams[0].onValue(runSnapshot('running', 7));
		await seconds(1);
		lastConnection!.close();
		await seconds(5);
		const conn = lastConnection!;
		expect(conn.payloads[0]).toMatchObject({ afterSequence: 7 });
		await seconds(45);
		expect(conn.cancels).toHaveBeenCalledTimes(1);
		expect(conn.payloads[1]).toEqual({ threadId: 't1' });
	});
});

describe('CodingFollower follow-up messages', () => {
	it('lets T3 decide when to start a follow-up, even while a run is active', async () => {
		failConnect = false;
		await follower.follow();
		const conn = lastConnection!;
		conn.streams[0].onValue(runSnapshot('running'));
		await seconds(1);
		const call = vi.spyOn(conn, 'call');

		await follower.sendMessage({ id: 'm2', text: 'next' });

		const dispatch = call.mock.calls.find(
			(c) => (c as unknown[])[0] === 'orchestration.dispatchCommand'
		) as unknown[] | undefined;
		// T3's own client default; `queue_after_active` would park it in T3's queue.
		expect(dispatch?.[1]).toMatchObject({
			type: 'message.dispatch',
			messageId: 'm2',
			deliveryIntent: 'auto',
			dispatchMode: { type: 'start_immediately' }
		});
	});
});

describe('CodingFollower omitted output', () => {
	const outputSnapshot = (sequence: number) => ({
		...runSnapshot('completed', sequence),
		projection: {
			...runSnapshot('completed', sequence).projection,
			turnItems: [
				{
					id: 'c1',
					runId: 'run-1',
					ordinal: 1,
					type: 'command_execution',
					status: 'completed',
					command: 'ls',
					outputOmitted: true
				}
			]
		}
	});

	it('retries a failed fetch later instead of caching an empty output', async () => {
		failConnect = false;
		await follower.follow();
		const conn = lastConnection!;
		const call = vi
			.spyOn(conn, 'call')
			.mockRejectedValueOnce(new Error('timeout'))
			.mockResolvedValue({ item: { output: 'file.txt' } });
		const fetches = () =>
			call.mock.calls.filter((c) => (c as unknown[])[0] === 'orchestration.getTurnItem');
		const stream = conn.streams[0];

		stream.onValue(outputSnapshot(1));
		await seconds(1);
		expect(fetches()).toHaveLength(1);
		stream.onValue(outputSnapshot(2));
		await seconds(1);
		expect(fetches()).toHaveLength(1); // not right away

		await seconds(30);
		stream.onValue(outputSnapshot(3));
		await seconds(1);
		expect(fetches()).toHaveLength(2);
		stream.onValue(outputSnapshot(4));
		await seconds(40);
		expect(fetches()).toHaveLength(2); // loaded now
	});

	it('fetches at most a few outputs at once and queues the rest', async () => {
		failConnect = false;
		await follower.follow();
		const conn = lastConnection!;
		let active = 0;
		let peak = 0;
		let fetched = 0;
		const pending: (() => void)[] = [];
		vi.spyOn(conn, 'call').mockImplementation((async (tag: string) => {
			if (tag !== 'orchestration.getTurnItem') return {};
			active++;
			peak = Math.max(peak, active);
			await new Promise<void>((resolve) => pending.push(resolve));
			active--;
			fetched++;
			return { item: { output: 'ok' } };
		}) as never);
		const base = runSnapshot('completed', 1);
		conn.streams[0].onValue({
			...base,
			projection: {
				...base.projection,
				turnItems: Array.from({ length: 10 }, (_, i) => ({
					id: `c${i}`,
					runId: 'run-1',
					ordinal: i + 1,
					type: 'command_execution',
					status: 'completed',
					outputOmitted: true
				}))
			}
		});
		await seconds(1);
		expect(pending).toHaveLength(4);
		while (fetched < 10) {
			const batch = pending.splice(0);
			if (batch.length === 0) break;
			for (const resolve of batch) resolve();
			await seconds(0);
		}
		expect(fetched).toBe(10);
		expect(peak).toBe(4);
	});
});

describe('CodingFollower change size', () => {
	it('re-reads the change size when edits land while a read is in flight', async () => {
		failConnect = false;
		await follower.follow();
		const conn = lastConnection!;
		const reads: ((value: unknown) => void)[] = [];
		vi.spyOn(conn, 'call').mockImplementation(((tag: string) =>
			tag === 'vcs.refreshStatus'
				? new Promise((resolve) => reads.push(resolve))
				: Promise.resolve({})) as never);
		const snap = (sequence: number, edits: number) => {
			const base = runSnapshot('completed', sequence);
			return {
				...base,
				projection: {
					...base.projection,
					thread: { id: 't1', worktreePath: '/wt' },
					turnItems: Array.from({ length: edits }, (_, i) => ({
						id: `f${i}`,
						runId: 'run-1',
						ordinal: i + 1,
						type: 'file_change',
						status: 'completed'
					}))
				}
			};
		};
		const stat = (insertions: number, deletions: number) => ({
			workingTree: { insertions, deletions }
		});

		conn.streams[0].onValue(snap(1, 0));
		await seconds(3);
		expect(reads).toHaveLength(1);
		conn.streams[0].onValue(snap(2, 1)); // an edit while the first read is in flight
		await seconds(3);
		reads[0](stat(1, 0));
		await seconds(0);
		expect(reads).toHaveLength(2);
		reads[1](stat(5, 2));
		await seconds(0);
		expect(coding.getCodingConversation(getDb(), conversationId)).toMatchObject({
			diff_insertions: 5,
			diff_deletions: 2
		});
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

describe('CodingFollower subagent status', () => {
	const subagentSnapshot = (runStatus: string, progress: string, status = 'running') => ({
		kind: 'snapshot',
		snapshotSequence: 1,
		projection: {
			thread: { id: 't1' },
			runs: [
				{
					id: 'run-1',
					ordinal: 1,
					status: runStatus,
					userMessageId: 'm1',
					requestedAt: '2026-11-07T10:00:00.000Z'
				}
			],
			turnItems: [
				{
					id: 's1',
					runId: 'run-1',
					ordinal: 1,
					type: 'subagent',
					status,
					title: 'Review',
					prompt: 'Review the diff',
					progress
				}
			]
		}
	});

	it('streams a running subagent’s progress as it changes', async () => {
		const { getStreamState } = await import('../chat/streams.js');
		failConnect = false;
		follower.beginTurn('m1');
		await follower.follow();
		const stream = lastConnection!.streams[0];

		stream.onValue(subagentSnapshot('running', 'Reading routes'));
		await seconds(1);
		stream.onValue(subagentSnapshot('running', 'Writing the report'));
		await seconds(1);

		const inputs = getStreamState(conversationId)!.chunks.filter(
			(c) => c.type === 'tool-input-available' && c.toolCallId === 's1'
		);
		expect(inputs).toHaveLength(1);
		expect(inputs[0]).toMatchObject({ input: { progress: 'Writing the report', running: true } });
	});

	it('tells an open chat to reload when a background subagent reports after its turn', async () => {
		const { publishServerEvent } = await import('../events/bus.js');
		failConnect = false;
		await follower.follow();
		const stream = lastConnection!.streams[0];

		stream.onValue(subagentSnapshot('completed', 'Reading routes'));
		await seconds(2);
		vi.mocked(publishServerEvent).mockClear();
		stream.onValue(subagentSnapshot('completed', 'Writing the report'));
		await seconds(2);

		expect(publishServerEvent).toHaveBeenCalledWith('u1', {
			type: 'chat.messages.updated',
			conversationId
		});
	});
});

describe('CodingFollower user stop', () => {
	const runningSnapshot = (sequence: number) => ({
		kind: 'snapshot',
		snapshotSequence: sequence,
		projection: {
			thread: { id: 't1' },
			runs: [
				{
					id: 'run-1',
					ordinal: 1,
					status: 'running',
					userMessageId: null,
					requestedAt: '2026-11-07T10:00:00.000Z'
				}
			],
			turnItems: [
				{
					id: 'a1',
					runId: 'run-1',
					ordinal: 1,
					type: 'assistant_message',
					status: 'running',
					streaming: true,
					text: 'Working'
				}
			]
		}
	});

	it('interrupts the run and does not reopen its stream while it is still running', async () => {
		const { abortStream, hasActiveStream } = await import('../chat/streams.js');
		failConnect = false;
		await follower.follow();
		const conn = lastConnection!;
		const callSpy = vi.spyOn(conn, 'call');
		conn.streams[0].onValue(runningSnapshot(1));
		await seconds(1);
		expect(hasActiveStream(conversationId)).toBe(true);

		expect(abortStream(conversationId)).toBe(true);
		// T3 hasn't processed the interrupt yet: the run still shows as running.
		conn.streams[0].onValue(runningSnapshot(2));
		await seconds(1);

		expect(hasActiveStream(conversationId)).toBe(false);
		expect(callSpy).toHaveBeenCalledWith(
			'orchestration.dispatchCommand',
			expect.objectContaining({ type: 'run.interrupt', runId: 'run-1' })
		);
	});
});

describe('CodingFollower agent notices', () => {
	it('does not mirror the agent runtime’s own notices as user messages', async () => {
		const { createMessage, getMessage } = await import('../db/repo/messages.js');
		const db = getDb();
		// Mirrored by an older version; cleaned up on the next render.
		createMessage(db, {
			id: 'n1',
			conversationId,
			role: 'user',
			parts: [{ type: 'text', text: 'Background task completed.' }],
			status: 'complete'
		});
		failConnect = false;
		await follower.follow();
		lastConnection!.streams[0].onValue({
			kind: 'snapshot',
			snapshotSequence: 1,
			projection: {
				thread: { id: 't1' },
				runs: [
					{
						id: 'r1',
						ordinal: 1,
						status: 'completed',
						userMessageId: 'u1m',
						requestedAt: '2026-11-07T10:00:00.000Z'
					},
					{
						id: 'r2',
						ordinal: 2,
						status: 'completed',
						userMessageId: 'n1',
						requestedAt: '2026-11-07T10:01:00.000Z'
					},
					{
						id: 'r3',
						ordinal: 3,
						status: 'completed',
						userMessageId: 'n2',
						requestedAt: '2026-11-07T10:02:00.000Z'
					}
				],
				messages: [
					{ id: 'u1m', role: 'user', createdBy: 'user', text: 'Fix the bug' },
					{
						id: 'n1',
						role: 'user',
						createdBy: 'agent',
						notification: { source: { kind: 'background_task' }, outcome: 'updated' },
						text: 'Background task completed.'
					},
					{
						id: 'n2',
						role: 'user',
						createdBy: 'agent',
						notification: { source: { kind: 'background_task', work: 'subagent' } },
						text: 'This agent’s report was delivered to you as a message from "a1".'
					}
				]
			}
		});
		await seconds(1);

		expect(getMessage(db, 'u1m')).toMatchObject({ role: 'user' });
		expect(getMessage(db, 'n1')).toBeUndefined();
		expect(getMessage(db, 'n2')).toBeUndefined();
	});
});

describe('CodingFollower mirrored message order', () => {
	const snapshot = (sequence: number, text: string | null) => ({
		kind: 'snapshot',
		snapshotSequence: sequence,
		projection: {
			thread: { id: 't1' },
			runs: [
				{
					id: 'r1',
					ordinal: 1,
					status: 'running',
					userMessageId: 'u1m',
					requestedAt: '2026-11-07T10:00:00.000Z',
					startedAt: '2026-11-07T10:00:01.000Z'
				}
			],
			messages: text === null ? [] : [{ id: 'u1m', role: 'user', createdBy: 'user', text }]
		}
	});

	it('puts the user message before the reply when following a thread that is already running', async () => {
		const { getMessage } = await import('../db/repo/messages.js');
		const db = getDb();
		failConnect = false;
		await follower.follow();
		lastConnection!.streams[0].onValue(snapshot(1, 'Fix the bug'));
		await seconds(1);

		expect(getMessage(db, 'u1m')).toMatchObject({ role: 'user', parent_id: null });
		expect(getMessage(db, 'u1m:reply')).toMatchObject({ role: 'assistant', parent_id: 'u1m' });
	});

	it('slots a user message whose text arrives late in before its reply', async () => {
		const { activeLeafId, getMessage } = await import('../db/repo/messages.js');
		const db = getDb();
		failConnect = false;
		await follower.follow();
		lastConnection!.streams[0].onValue(snapshot(1, null));
		await seconds(1);
		expect(getMessage(db, 'u1m:reply')).toMatchObject({ parent_id: null });

		lastConnection!.streams[0].onValue(snapshot(2, 'Fix the bug'));
		await seconds(1);

		expect(getMessage(db, 'u1m')).toMatchObject({ role: 'user', parent_id: null });
		expect(getMessage(db, 'u1m:reply')).toMatchObject({ parent_id: 'u1m' });
		expect(activeLeafId(db, conversationId)).toBe('u1m:reply');
	});
});
