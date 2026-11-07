import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

let release: () => void = () => {};
const follower = {
	beginTurn: vi.fn(),
	failTurn: vi.fn(),
	follow: vi.fn(async () => {}),
	launch: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
	sendMessage: vi.fn(async () => {}),
	respond: vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
};
vi.doMock('./follower.js', () => ({
	ensureFollower: () => follower,
	getFollower: () => undefined
}));
vi.doMock('./client.js', () => ({
	connectT3: vi.fn(),
	t3HttpGet: vi.fn(),
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
