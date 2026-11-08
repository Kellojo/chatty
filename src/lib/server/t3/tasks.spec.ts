import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

let release: () => void = () => {};
const follower = {
	beginTurn: vi.fn(),
	failTurn: vi.fn(),
	follow: vi.fn(async () => {}),
	launch: vi.fn<(input: { threadId: string }) => Promise<void>>(
		() => new Promise<void>((resolve) => (release = resolve))
	),
	sendMessage: vi.fn(async () => {}),
	respond: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
	stop: vi.fn()
};
const t3HttpGet = vi.fn();
vi.doMock('./follower.js', () => ({
	ensureFollower: () => follower,
	getFollower: () => undefined
}));
vi.doMock('./client.js', () => ({
	connectT3: vi.fn(),
	t3HttpGet,
	T3ClientError: class extends Error {}
}));
vi.doMock('../events/bus.js', () => ({ publishServerEvent: vi.fn() }));

const { openDatabase } = await import('../db/index.js');
const conversations = await import('../db/repo/conversations.js');
const coding = await import('../db/repo/coding-conversations.js');
const { createCodingEnvironment } = await import('../db/repo/coding-environments.js');
const { startCodingTurn, respondToCodingRequest } = await import('./tasks.js');

type Db = ReturnType<typeof openDatabase>;
let db: Db;
let conversationId: string;

beforeEach(() => {
	for (const fn of Object.values(follower)) fn.mockClear();
	t3HttpGet.mockReset();
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
		workspaceMode: 'local',
		baseBranch: null
	});
});

const message = (id: string) => ({
	id,
	role: 'user' as const,
	parts: [{ type: 'text' as const, text: `hello ${id}` }]
});

describe('startCodingTurn', () => {
	it('launches one thread when two first messages arrive at once', async () => {
		const row = coding.getCodingConversation(db, conversationId)!;
		const first = startCodingTurn('u1', row, message('m1'), db);
		const second = startCodingTurn('u1', row, message('m2'), db);
		await vi.waitFor(() => expect(follower.launch).toHaveBeenCalledTimes(1));
		release();
		await Promise.all([first, second]);
		expect(follower.launch).toHaveBeenCalledTimes(1);
		expect(follower.sendMessage).toHaveBeenCalledWith({ id: 'm2', text: 'hello m2' });
	});

	it('forgets the thread of a failed launch, so the next message launches again', async () => {
		follower.launch.mockRejectedValueOnce(new Error('timeout'));
		t3HttpGet.mockResolvedValueOnce({ threads: [], archivedThreads: [] });
		const row = coding.getCodingConversation(db, conversationId)!;
		await expect(startCodingTurn('u1', row, message('m1'), db)).rejects.toMatchObject({
			status: 500
		});
		const failed = coding.getCodingConversation(db, conversationId)!;
		expect(failed.thread_id).toBeNull();
		expect(failed.status).toBe('failed');
		expect(follower.failTurn).toHaveBeenCalledOnce();
		expect(follower.stop).toHaveBeenCalledOnce();
		expect(follower.follow).not.toHaveBeenCalled();

		const next = startCodingTurn('u1', failed, message('m2'), db);
		await vi.waitFor(() => expect(follower.launch).toHaveBeenCalledTimes(2));
		release();
		await next;
		expect(follower.sendMessage).not.toHaveBeenCalled();
	});

	it('treats a failed launch whose thread exists on T3 as launched', async () => {
		follower.launch.mockRejectedValueOnce(new Error('timeout'));
		t3HttpGet.mockImplementationOnce(async () => ({
			threads: [{ id: follower.launch.mock.calls[0][0].threadId }],
			archivedThreads: []
		}));
		const row = coding.getCodingConversation(db, conversationId)!;
		await startCodingTurn('u1', row, message('m1'), db);
		expect(coding.getCodingConversation(db, conversationId)!.thread_id).toBe(
			follower.launch.mock.calls[0][0].threadId
		);
		expect(follower.failTurn).not.toHaveBeenCalled();
		expect(follower.stop).not.toHaveBeenCalled();
		expect(follower.follow).toHaveBeenCalledOnce();
	});

	it('keeps following the thread when a follow-up fails to send', async () => {
		coding.updateCodingConversation(db, conversationId, { threadId: 't1', status: 'idle' });
		follower.sendMessage.mockRejectedValueOnce(new Error('boom'));
		const row = coding.getCodingConversation(db, conversationId)!;
		await expect(startCodingTurn('u1', row, message('m1'), db)).rejects.toMatchObject({
			status: 500
		});
		const after = coding.getCodingConversation(db, conversationId)!;
		expect(after.thread_id).toBe('t1');
		expect(after.status).toBe('idle');
		expect(follower.stop).not.toHaveBeenCalled();
		expect(follower.follow).toHaveBeenCalledOnce();
	});
});

describe('respondToCodingRequest', () => {
	it('sends an answer only once on a double click', async () => {
		coding.updateCodingConversation(db, conversationId, {
			threadId: 't1',
			pendingRequest: {
				kind: 'approval',
				requestId: 'req1',
				title: 'Run a command?',
				detail: null,
				options: [{ id: 'accept', label: 'Accept' }] as never,
				allowFreeText: false,
				createdAt: 0
			}
		});
		const first = respondToCodingRequest(
			'u1',
			conversationId,
			{ requestId: 'req1', optionId: 'accept' },
			db
		);
		const second = respondToCodingRequest(
			'u1',
			conversationId,
			{ requestId: 'req1', optionId: 'accept' },
			db
		);
		await expect(second).rejects.toMatchObject({ status: 409 });
		release();
		await first.catch(() => {});
		expect(follower.respond).toHaveBeenCalledTimes(1);
	});
});
