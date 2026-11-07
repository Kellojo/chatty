import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

type Handlers = { onValue: (value: unknown) => void; onEnd: (error: Error | null) => void };
const streams: { tag: string; payload: unknown; handlers: Handlers; cancel: () => void }[] = [];
const fakeConnection = () => ({
	stream: vi.fn((tag: string, payload: unknown, handlers: Handlers) => {
		const stream = { tag, payload, handlers, cancel: vi.fn() };
		streams.push(stream);
		return { cancel: stream.cancel };
	}),
	call: vi.fn(async () => ({})),
	close: vi.fn()
});
const connectT3 = vi.fn(async () => fakeConnection());
const t3HttpGet = vi.fn(async (): Promise<unknown> => ({
	projects: [],
	threads: [],
	archivedThreads: []
}));
vi.doMock('./client.js', () => ({ connectT3, t3HttpGet }));
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
const { syncAllThreads, stopThreadSync } = await import('./thread-sync.js');

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

afterEach(() => stopThreadSync());

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

		stream.handlers.onValue({ kind: 'snapshot', snapshot: { threads: [settled] } });
		expect(conversations.getConversation(db, 'u1', conversationId)!.settled_at).toBeNull();

		stream.handlers.onValue({ kind: 'thread.updated', location: 'active', thread: settled });
		expect(conversations.getConversation(db, 'u1', conversationId)!.settled_at).not.toBeNull();
		expect(coding.getCodingConversation(db, conversationId)!.remote_settled).toBe(1);

		stream.handlers.onValue({
			kind: 'thread.updated',
			thread: { id: 't1', settledAt: null, settledOverride: 'active' }
		});
		expect(conversations.getConversation(db, 'u1', conversationId)!.settled_at).toBeNull();
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
