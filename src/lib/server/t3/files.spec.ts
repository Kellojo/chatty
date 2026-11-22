import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const call = vi.fn<(tag: string, payload?: unknown) => Promise<unknown>>();
const t3HttpGet = vi.fn(async (): Promise<unknown> => ({}));
const { T3ClientError } = await import('./client.js');
vi.doMock('./client.js', () => ({
	connectT3: vi.fn(async () => ({ closed: false, call, onClose: () => () => {}, close: vi.fn() })),
	t3HttpGet,
	T3ClientError
}));
vi.doMock('../events/bus.js', () => ({ publishServerEvent: vi.fn() }));

const { openDatabase } = await import('../db/index.js');
const conversations = await import('../db/repo/conversations.js');
const coding = await import('../db/repo/coding-conversations.js');
const { createMessage } = await import('../db/repo/messages.js');
const { createCodingEnvironment } = await import('../db/repo/coding-environments.js');
const { readCodingFile, workspaceRelativePath } = await import('./files.js');
const { closeAllT3Connections } = await import('./pool.js');

describe('workspaceRelativePath', () => {
	it('resolves absolute paths inside the workspace', () => {
		expect(workspaceRelativePath('/wt/t1', '/wt/t1/src/a.ts')).toBe('src/a.ts');
		expect(workspaceRelativePath('/wt/t1/', '/wt/t1/./src/a.ts')).toBe('src/a.ts');
		expect(workspaceRelativePath(String.raw`C:\Repo`, String.raw`c:\repo\src\a.ts`)).toBe(
			'src/a.ts'
		);
		expect(workspaceRelativePath(String.raw`C:\Repo`, 'C:/Repo/a.ts')).toBe('a.ts');
	});

	it('passes relative paths through', () => {
		expect(workspaceRelativePath('/wt', 'src/a.ts')).toBe('src/a.ts');
		expect(workspaceRelativePath('/wt', String.raw`.\src\a.ts`)).toBe('src/a.ts');
	});

	it('refuses paths outside the workspace', () => {
		expect(workspaceRelativePath('/wt/t1', '/wt/t10/a.ts')).toBeNull();
		expect(workspaceRelativePath('/wt/t1', '/etc/passwd')).toBeNull();
		expect(workspaceRelativePath('/wt/t1', '/wt/t1/../x/a.ts')).toBeNull();
		expect(workspaceRelativePath('/wt/t1', '../a.ts')).toBeNull();
		expect(workspaceRelativePath('/wt/t1', '/wt/t1')).toBeNull();
		// POSIX paths are case-sensitive.
		expect(workspaceRelativePath('/wt/T1', '/wt/t1/a.ts')).toBeNull();
	});
});

describe('readCodingFile', () => {
	type Db = ReturnType<typeof openDatabase>;
	let db: Db;
	let conversationId: string;

	beforeEach(() => {
		closeAllT3Connections();
		call.mockReset();
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
		conversationId = conversations.createConversation(db, 'u1', { kind: 'chat', title: 'Task' }).id;
		coding.createCodingConversation(db, {
			conversationId,
			environmentId: env.id,
			projectId: 'p1',
			projectTitle: 'Project',
			providerInstanceId: 'codex',
			model: 'gpt',
			runtimeMode: 'auto',
			workspaceMode: 'worktree',
			baseBranch: 'main'
		});
		coding.updateCodingConversation(db, conversationId, { threadId: 't1' });
		t3HttpGet.mockResolvedValue({
			threads: [{ id: 't1', worktreePath: '/wt/t1' }],
			archivedThreads: []
		});
	});

	it("reads a file in the thread's worktree relative to it", async () => {
		call.mockResolvedValueOnce({
			relativePath: 'src/a.ts',
			contents: 'one\ntwo\n',
			byteLength: 8,
			truncated: false
		});
		const file = await readCodingFile(db, 'u1', conversationId, '/wt/t1/src/a.ts');
		expect(call).toHaveBeenCalledWith('projects.readFile', {
			cwd: '/wt/t1',
			relativePath: 'src/a.ts',
			allowMissing: true
		});
		expect(file).toEqual({
			absolutePath: '/wt/t1/src/a.ts',
			workspacePath: 'src/a.ts',
			exists: true,
			contents: 'one\ntwo\n',
			byteLength: 8,
			truncated: false
		});
	});

	it('resolves a relative path against the worktree', async () => {
		call.mockResolvedValueOnce({ contents: '', byteLength: 0, truncated: false, exists: false });
		const file = await readCodingFile(db, 'u1', conversationId, 'src/gone.ts');
		expect(file).toMatchObject({ absolutePath: '/wt/t1/src/gone.ts', exists: false });
	});

	it('reads a file outside the workspace only if the agent referenced it', async () => {
		await expect(
			readCodingFile(db, 'u1', conversationId, '/home/me/notes.md')
		).rejects.toMatchObject({
			status: 404
		});
		expect(call).not.toHaveBeenCalled();

		createMessage(db, {
			conversationId,
			role: 'assistant',
			parts: [{ type: 'text', text: 'See [notes](/home/me/notes.md:3).' }]
		});
		call.mockResolvedValueOnce({ contents: 'hi', byteLength: 2, truncated: false });
		const file = await readCodingFile(db, 'u1', conversationId, '/home/me/notes.md');
		expect(call).toHaveBeenCalledWith('projects.readFile', {
			cwd: '/home/me',
			relativePath: 'notes.md',
			allowMissing: true
		});
		expect(file.workspacePath).toBeNull();
	});

	it('explains that ~ paths need the full path', async () => {
		await expect(readCodingFile(db, 'u1', conversationId, '~/notes.md')).rejects.toMatchObject({
			status: 404,
			message: expect.stringContaining('full path')
		});
		expect(call).not.toHaveBeenCalled();
	});

	it("passes on T3's reason a file can't be read", async () => {
		call.mockRejectedValueOnce(
			new T3ClientError("This is a binary file, so it can't be shown.", 'remote')
		);
		await expect(readCodingFile(db, 'u1', conversationId, 'a.png')).rejects.toMatchObject({
			status: 422,
			message: "This is a binary file, so it can't be shown."
		});
	});

	it('asks to re-pair a token without file access', async () => {
		call.mockRejectedValueOnce(
			new T3ClientError('Token is missing the "filesystem:read" scope', 'unauthorized')
		);
		await expect(readCodingFile(db, 'u1', conversationId, 'a.ts')).rejects.toMatchObject({
			status: 403,
			message: expect.stringContaining('Re-pair')
		});
	});

	it("is not found for another user's task", async () => {
		await expect(readCodingFile(db, 'u2', conversationId, 'a.ts')).rejects.toMatchObject({
			status: 404
		});
	});
});
