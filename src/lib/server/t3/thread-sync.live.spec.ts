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
const t3HttpGet = vi.fn(async () => ({ projects: [], threads: [], archivedThreads: [] }));
vi.doMock('./client.js', () => ({ connectT3, t3HttpGet }));
vi.doMock('./follower.js', () => ({
	ensureFollower: vi.fn(() => ({ follow: vi.fn() })),
	getFollower: () => undefined
}));
vi.doMock('../events/bus.js', () => ({ publishServerEvent: vi.fn() }));

const { openDatabase } = await import('../db/index.js');
const conversations = await import('../db/repo/conversations.js');
const coding = await import('../db/repo/coding-conversations.js');
const { createCodingEnvironment } = await import('../db/repo/coding-environments.js');
const { syncAllThreads, stopThreadSync } = await import('./thread-sync.js');

type Db = ReturnType<typeof openDatabase>;
let db: Db;
let conversationId: string;

beforeEach(() => {
	streams.length = 0;
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
		diff: { insertions: 0, deletions: 0 }
	});
});

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

	it('stops watching on shutdown', async () => {
		const stream = await shellStream();
		stopThreadSync();
		expect(stream.cancel).toHaveBeenCalled();
	});
});
