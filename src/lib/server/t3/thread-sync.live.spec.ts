import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

type Handlers = { onValue: (value: unknown) => void; onEnd: (error: Error | null) => void };
const streams: { tag: string; payload: unknown; handlers: Handlers; cancel: () => void }[] = [];
const fakeConnection = () => {
	const conn = {
		closed: false,
		stream: vi.fn((tag: string, payload: unknown, handlers: Handlers) => {
			const stream = { tag, payload, handlers, cancel: vi.fn() };
			streams.push(stream);
			return { cancel: stream.cancel };
		}),
		onClose: vi.fn(() => () => {}),
		call: vi.fn(async () => ({})),
		close: vi.fn(() => {
			conn.closed = true;
		})
	};
	return conn;
};
const connectT3 = vi.fn(async () => fakeConnection());
const t3HttpGet = vi.fn(async (): Promise<unknown> => ({
	projects: [],
	threads: [],
	archivedThreads: []
}));
const { T3ClientError } = await import('./client.js');
vi.doMock('./client.js', () => ({ connectT3, t3HttpGet, T3ClientError }));
const ensureFollower = vi.fn<(input: { conversationId: string }) => { follow: () => void }>(() => ({
	follow: vi.fn()
}));
vi.doMock('./follower.js', () => ({ ensureFollower, getFollower: () => undefined }));
vi.doMock('../events/bus.js', () => ({ publishServerEvent: vi.fn() }));

const { openDatabase } = await import('../db/index.js');
const conversations = await import('../db/repo/conversations.js');
const coding = await import('../db/repo/coding-conversations.js');
const { createCodingEnvironment, updateCodingEnvironment } =
	await import('../db/repo/coding-environments.js');
const { syncAllThreads, stopThreadSync, LIVE_IMPORT_DEBOUNCE_MS } =
	await import('./thread-sync.js');
const { closeAllT3Connections } = await import('./pool.js');

type Db = ReturnType<typeof openDatabase>;
let db: Db;
let conversationId: string;

beforeEach(() => {
	streams.length = 0;
	ensureFollower.mockClear();
	db = openDatabase(':memory:');
	const now = Date.now();
	db.prepare(
		`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'u1', 'u1@example.com', 0, ?, ?, 'user')`
	).run(now, now);
	const env = createCodingEnvironment(db, 'u1', {
		name: 'T3',
		baseUrl: 'http://t3.test',
		token: 'token'
	});
	conversationId = conversations.createConversation(db, 'u1', {
		kind: 'chat',
		mode: 'agent',
		title: 'Fix the build'
	}).id;
	coding.createCodingConversation(db, {
		conversationId,
		environmentId: env.id,
		projectId: 'p1',
		projectTitle: 'Project',
		providerInstanceId: 'codex',
		model: 'gpt',
		runtimeMode: 'auto',
		workspaceMode: 'worktree',
		baseBranch: null
	});
	coding.updateCodingConversation(db, conversationId, {
		threadId: 't1',
		remoteSettled: false,
		diff: { insertions: 0, deletions: 0 },
		status: 'idle'
	});
});

const envId = () => coding.getCodingConversation(db, conversationId)!.environment_id!;
const followed = () => ensureFollower.mock.calls.map(([input]) => input.conversationId);

afterEach(() => {
	stopThreadSync();
	closeAllT3Connections();
	vi.useRealTimers();
});

const shellStream = async () => {
	await syncAllThreads(db);
	await vi.waitFor(() => expect(streams).toHaveLength(1));
	return streams[0];
};

describe('live shell watch', () => {
	it('subscribes to the shell of each enabled environment', async () => {
		const stream = await shellStream();
		expect(stream.tag).toBe('orchestration.subscribeShell');
		// A second pass keeps the existing subscription.
		await syncAllThreads(db);
		expect(connectT3).toHaveBeenCalledTimes(1);
	});

	it('settles a task as soon as T3 reports its thread settled', async () => {
		const stream = await shellStream();
		const settled = { id: 't1', settledAt: '2026-11-07T17:45:41.897Z', settledOverride: 'settled' };

		stream.handlers.onValue({ kind: 'thread.updated', location: 'active', thread: settled });
		expect(conversations.getConversation(db, 'u1', conversationId)!.settled_at).not.toBeNull();
		expect(coding.getCodingConversation(db, conversationId)!.remote_settled).toBe(1);

		stream.handlers.onValue({
			kind: 'thread.updated',
			thread: { id: 't1', settledAt: null, settledOverride: 'active' }
		});
		expect(conversations.getConversation(db, 'u1', conversationId)!.settled_at).toBeNull();
	});

	it('catches up from the snapshot it gets on (re)connect', async () => {
		const stream = await shellStream();
		const settled = { id: 't1', settledAt: '2026-11-07T17:45:41.897Z', activeRunId: 'r1' };

		stream.handlers.onValue({ kind: 'snapshot', snapshot: { threads: [settled] } });

		expect(conversations.getConversation(db, 'u1', conversationId)!.settled_at).not.toBeNull();
		expect(followed()).toEqual([conversationId]);
	});

	it('resubscribes after the stream ends, reopening the shared socket only once it closed', async () => {
		const stream = await shellStream();
		const connects = connectT3.mock.calls.length;
		vi.useFakeTimers();

		stream.handlers.onEnd(new Error('stream failed'));
		await vi.advanceTimersByTimeAsync(2000);
		expect(streams).toHaveLength(2);
		expect(connectT3.mock.calls.length).toBe(connects); // same socket

		const conn = await connectT3.mock.results.at(-1)!.value;
		conn.closed = true;
		streams[1].handlers.onEnd(new Error('Connection closed'));
		await vi.advanceTimersByTimeAsync(2000);
		expect(streams).toHaveLength(2); // backing off: 4 s now
		await vi.advanceTimersByTimeAsync(2000);
		expect(streams).toHaveLength(3);
		expect(connectT3.mock.calls.length).toBe(connects + 1);

		// A value resets the backoff.
		streams[2].handlers.onValue({ kind: 'snapshot', snapshot: { threads: [] } });
		streams[2].handlers.onEnd(new Error('stream failed'));
		await vi.advanceTimersByTimeAsync(2000);
		expect(streams).toHaveLength(4);
	});

	it('imports a thread T3 reports that Chatty does not know yet, once per burst', async () => {
		const stream = await shellStream();
		const loads = t3HttpGet.mock.calls.length;
		vi.useFakeTimers();
		const now = new Date(Date.now() + 1000).toISOString();
		const fresh = {
			id: 't9',
			projectId: 'p1',
			title: 'New on T3',
			modelSelection: { instanceId: 'codex', model: 'gpt-5' },
			runtimeMode: 'full-access',
			createdAt: now,
			updatedAt: now
		};
		t3HttpGet.mockResolvedValueOnce({
			projects: [{ id: 'p1', title: 'Project' }],
			threads: [fresh],
			archivedThreads: []
		});

		stream.handlers.onValue({ kind: 'thread.updated', thread: fresh });
		stream.handlers.onValue({ kind: 'thread.updated', thread: { ...fresh, title: 'Renamed' } });
		// Known threads and subagents don't trigger an import.
		stream.handlers.onValue({ kind: 'thread.updated', thread: { id: 't1', updatedAt: now } });
		await vi.advanceTimersByTimeAsync(LIVE_IMPORT_DEBOUNCE_MS);

		expect(t3HttpGet.mock.calls.length).toBe(loads + 1);
		expect(coding.listKnownThreadIds(db, envId())).toEqual(new Set(['t1', 't9']));
		expect(ensureFollower).toHaveBeenCalledWith(
			expect.objectContaining({ threadId: 't9', quietHistory: true })
		);
	});

	it('follows a task as soon as T3 reports its thread running', async () => {
		const stream = await shellStream();
		stream.handlers.onValue({ kind: 'thread.updated', thread: { id: 't1' } });
		expect(followed()).toEqual([]);

		stream.handlers.onValue({ kind: 'thread.updated', thread: { id: 't1', activeRunId: 'r1' } });
		expect(followed()).toEqual([conversationId]);
	});

	it('stops watching on shutdown', async () => {
		const stream = await shellStream();
		stopThreadSync();
		expect(stream.cancel).toHaveBeenCalled();
	});
});

describe('periodic pass', () => {
	it('leaves idle tasks with an idle thread alone', async () => {
		t3HttpGet.mockResolvedValueOnce({ projects: [], threads: [{ id: 't1' }], archivedThreads: [] });
		await syncAllThreads(db);
		expect(followed()).toEqual([]);
	});

	it('follows a task whose stored status is still active though its thread is idle', async () => {
		coding.updateCodingConversation(db, conversationId, { status: 'running' });
		t3HttpGet.mockResolvedValueOnce({ projects: [], threads: [{ id: 't1' }], archivedThreads: [] });
		await syncAllThreads(db);
		expect(followed()).toEqual([conversationId]);
	});

	it('ends a task still marked active whose thread is gone on T3, instead of following it', async () => {
		const { publishServerEvent } = await import('../events/bus.js');
		coding.updateCodingConversation(db, conversationId, { status: 'running' });
		t3HttpGet.mockResolvedValueOnce({ projects: [], threads: [], archivedThreads: [] });
		await syncAllThreads(db);

		expect(followed()).toEqual([]);
		expect(coding.getCodingConversation(db, conversationId)).toMatchObject({
			status: 'failed',
			last_error: expect.stringContaining('no longer exists')
		});
		expect(publishServerEvent).toHaveBeenCalledWith(
			'u1',
			expect.objectContaining({ type: 'coding.thread.finished', conversationId, status: 'failed' })
		);
	});

	it('keeps a task active when its thread is only archived, or the shell has no thread lists', async () => {
		coding.updateCodingConversation(db, conversationId, { status: 'running' });
		t3HttpGet.mockResolvedValueOnce({ projects: [], threads: [], archivedThreads: [{ id: 't1' }] });
		await syncAllThreads(db);
		t3HttpGet.mockResolvedValueOnce({ projects: [] });
		await syncAllThreads(db);
		expect(coding.getCodingConversation(db, conversationId)!.status).toBe('running');
	});

	it('skips an environment disabled or re-keyed while its threads were loading', async () => {
		coding.updateCodingConversation(db, conversationId, { status: 'running' });
		const shell = { projects: [], threads: [{ id: 't1' }], archivedThreads: [] };
		t3HttpGet.mockImplementationOnce(async () => {
			updateCodingEnvironment(db, 'u1', envId(), { enabled: false });
			return shell;
		});
		await syncAllThreads(db);
		updateCodingEnvironment(db, 'u1', envId(), { enabled: true });
		t3HttpGet.mockImplementationOnce(async () => {
			updateCodingEnvironment(db, 'u1', envId(), { token: 'new-token' });
			return shell;
		});
		await syncAllThreads(db);
		expect(followed()).toEqual([]);
	});

	it('stops touching anything once the pass is cancelled', async () => {
		coding.updateCodingConversation(db, conversationId, { status: 'running' });
		const pass = { cancelled: false };
		t3HttpGet.mockImplementationOnce(async () => {
			pass.cancelled = true;
			return { projects: [], threads: [{ id: 't1' }], archivedThreads: [] };
		});
		await syncAllThreads(db, pass);
		expect(followed()).toEqual([]);
	});

	it('ignores live updates once the environment was re-keyed', async () => {
		const stream = await shellStream();
		updateCodingEnvironment(db, 'u1', envId(), { token: 'new-token' });
		stream.handlers.onValue({ kind: 'thread.updated', thread: { id: 't1', activeRunId: 'r1' } });
		expect(followed()).toEqual([]);
	});
});
