import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

// Past the allow-list the relay would dial T3; fail there so tests stay offline.
vi.doMock('./client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./client.js')>();
	return {
		...actual,
		connectT3: vi.fn(async () => {
			throw new actual.T3ClientError('Server unreachable', 'unreachable');
		})
	};
});

const { openDatabase } = await import('../db/index.js');
const conversations = await import('../db/repo/conversations.js');
const coding = await import('../db/repo/coding-conversations.js');
const { createMessage } = await import('../db/repo/messages.js');
const { createCodingEnvironment } = await import('../db/repo/coding-environments.js');
const { containsPath, fetchCodingImage } = await import('./assets.js');

type Db = ReturnType<typeof openDatabase>;
let db: Db;
let conversationId: string;

beforeEach(() => {
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
		title: 'Task'
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
	coding.updateCodingConversation(db, conversationId, { threadId: 't1' });
});

const say = (role: 'user' | 'assistant', text: string) =>
	createMessage(db, { conversationId, role, parts: [{ type: 'text', text }] });
const status = (path: string) =>
	fetchCodingImage(db, 'u1', conversationId, path).then(
		() => 200,
		(e: { status: number }) => e.status
	);

describe('containsPath', () => {
	it('matches whole paths only', () => {
		expect(containsPath('![shot](/home/me/a.png)', '/home/me/a.png')).toBe(true);
		expect(containsPath('Saved to C:\\x\\a.png.', 'C:\\x\\a.png')).toBe(true);
		expect(containsPath('/home/me/a.png', '/home/me/a.png')).toBe(true);
		expect(containsPath('/srv/home/me/a.png', '/home/me/a.png')).toBe(false);
		expect(containsPath('/home/me/a.png.png', '/home/me/a.png')).toBe(false);
		expect(containsPath('/home/me/a.png/b.png', '/home/me/a.png')).toBe(false);
	});
});

describe('fetchCodingImage allow-list', () => {
	it('only serves paths an assistant message referenced', async () => {
		say('user', 'Please show /home/me/.ssh/id.png');
		say('assistant', 'Here: ![shot](/home/me/shots/a.png)');
		// Referenced: passes the allow-list and fails only at the (mocked) T3 call.
		expect(await status('/home/me/shots/a.png')).toBe(502);
		expect(await status('/home/me/.ssh/id.png')).toBe(404);
	});

	it('refuses a path that is only part of a longer referenced one', async () => {
		say('assistant', 'See /srv/home/me/a.png and C:\\shots\\b.png.png');
		expect(await status('/srv/home/me/a.png')).toBe(502);
		expect(await status('/home/me/a.png')).toBe(404);
		expect(await status('C:\\shots\\b.png')).toBe(404);
	});
});
