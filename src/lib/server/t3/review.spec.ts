import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const call = vi.fn<(tag: string, payload?: unknown) => Promise<unknown>>(async () => ({
	sources: []
}));
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
const { createCodingEnvironment } = await import('../db/repo/coding-environments.js');
const messages = await import('../db/repo/messages.js');
const { getCodingTaskDiff, latestCheckpointTurn, parseDiffPreview } = await import('./review.js');
const { closeAllT3Connections } = await import('./pool.js');

const DIFF = [
	'diff --git a/a.ts b/a.ts',
	'--- a/a.ts',
	'+++ b/a.ts',
	'@@ -1 +1 @@',
	'-old',
	'+new',
	''
].join('\n');

describe('parseDiffPreview', () => {
	it('reads each source with its files', () => {
		const diff = parseDiffPreview({
			cwd: '/repo',
			sources: [
				{ id: 'w', kind: 'working-tree', title: 'Working tree', diff: DIFF, truncated: false },
				{ id: 'b', kind: 'branch-range', title: 'Against main', baseRef: 'main', diff: '' },
				{ id: 'x', kind: 'nonsense', diff: DIFF }
			]
		});
		expect(diff.sources.map((s) => [s.kind, s.title, s.files.length])).toEqual([
			['working-tree', 'Working tree', 1],
			['branch-range', 'Against main', 0]
		]);
		expect(diff.sources[0].files[0]).toMatchObject({ path: 'a.ts', additions: 1, deletions: 1 });
		expect(diff.sources[1].baseRef).toBe('main');
	});

	it('lists files a truncated diff left out from T3 stats', () => {
		const diff = parseDiffPreview({
			sources: [
				{
					kind: 'branch-range',
					title: 'Branch',
					diff: DIFF,
					truncated: true,
					files: [
						{ path: 'a.ts', previousPath: null, additions: 1, deletions: 1 },
						{ path: 'b.ts', previousPath: null, additions: 40, deletions: 2 }
					]
				}
			]
		});
		const [source] = diff.sources;
		expect(source.truncated).toBe(true);
		expect(source.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
		expect(source.files[1]).toMatchObject({ additions: 40, deletions: 2, truncated: true });
	});

	it('tolerates an unexpected answer', () => {
		expect(parseDiffPreview(null)).toEqual({ sources: [] });
		expect(parseDiffPreview({ sources: 'x' })).toEqual({ sources: [] });
	});
});

describe('getCodingTaskDiff', () => {
	type Db = ReturnType<typeof openDatabase>;
	let db: Db;
	let conversationId: string;

	beforeEach(() => {
		closeAllT3Connections();
		call.mockClear();
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
			baseBranch: 'main'
		});
	});

	it('has nothing to show before the thread exists', async () => {
		expect(await getCodingTaskDiff(db, 'u1', conversationId)).toEqual({ sources: [] });
		expect(call).not.toHaveBeenCalled();
	});

	it("asks T3 for the diff of the thread's worktree", async () => {
		coding.updateCodingConversation(db, conversationId, { threadId: 't1' });
		t3HttpGet.mockResolvedValueOnce({
			threads: [{ id: 't1', worktreePath: '/wt/t1' }],
			archivedThreads: []
		});
		call.mockResolvedValueOnce({
			sources: [{ kind: 'working-tree', title: 'Working tree', diff: DIFF }]
		});
		const diff = await getCodingTaskDiff(db, 'u1', conversationId);
		expect(call).toHaveBeenCalledWith('review.getDiffPreview', {
			cwd: '/wt/t1',
			ignoreWhitespace: false
		});
		expect(diff.sources[0].files[0].path).toBe('a.ts');
	});

	it('falls back to the project checkout', async () => {
		coding.updateCodingConversation(db, conversationId, { threadId: 't1' });
		t3HttpGet
			.mockResolvedValueOnce({ threads: [{ id: 't1', worktreePath: null }], archivedThreads: [] })
			.mockResolvedValueOnce({ projects: [{ id: 'p1', workspaceRoot: '/repo' }] });
		await getCodingTaskDiff(db, 'u1', conversationId);
		expect(call.mock.calls[0][1]).toEqual({ cwd: '/repo', ignoreWhitespace: false });
	});

	it("is not found for another user's task", async () => {
		await expect(getCodingTaskDiff(db, 'u2', conversationId)).rejects.toMatchObject({
			status: 404
		});
	});

	describe('without filesystem access', () => {
		const noScope = () =>
			new T3ClientError('Token is missing the "filesystem:read" scope', 'remote');

		beforeEach(() => {
			coding.updateCodingConversation(db, conversationId, { threadId: 't1' });
			t3HttpGet.mockResolvedValueOnce({
				threads: [{ id: 't1', worktreePath: '/wt/t1' }],
				archivedThreads: []
			});
		});

		it("uses the thread's own diff up to its latest checkpoint", async () => {
			call.mockImplementation(async (tag) => {
				if (tag === 'review.getDiffPreview') throw noScope();
				if (tag === 'orchestration.getThreadProjection') {
					return {
						checkpoints: [
							{ appRunOrdinal: null, status: 'ready' },
							{ appRunOrdinal: 2, status: 'ready' },
							{ appRunOrdinal: 3, status: 'missing' }
						]
					};
				}
				return { threadId: 't1', diff: DIFF };
			});
			const diff = await getCodingTaskDiff(db, 'u1', conversationId);
			expect(call).toHaveBeenCalledWith('orchestration.getFullThreadDiff', {
				threadId: 't1',
				toTurnCount: 2,
				ignoreWhitespace: false
			});
			expect(diff.sources[0].files[0]).toMatchObject({ path: 'a.ts', additions: 1 });
			call.mockReset();
			call.mockResolvedValue({ sources: [] });
		});

		it('lists the files the stored checkpoint steps report when T3 has no run checkpoints', async () => {
			call.mockImplementation(async (tag) => {
				if (tag === 'review.getDiffPreview') throw noScope();
				return { checkpoints: [{ appRunOrdinal: null, status: 'ready' }] };
			});
			const checkpoint = (input: unknown) => ({
				type: 'dynamic-tool',
				toolName: 'checkpoint',
				toolCallId: 'c',
				state: 'output-available',
				input,
				output: {}
			});
			messages.createMessage(db, {
				id: 'm1',
				conversationId,
				role: 'assistant',
				parts: [
					// Stored before per-file counts were kept: paths only.
					checkpoint({ files: ['old.ts'] }),
					checkpoint({
						files: ['a.ts'],
						changes: [{ path: 'a.ts', kind: 'added', additions: 3, deletions: 0 }]
					})
				]
			});
			messages.createMessage(db, {
				id: 'm2',
				conversationId,
				role: 'assistant',
				parts: [
					checkpoint({
						files: ['a.ts'],
						changes: [{ path: 'a.ts', kind: 'modified', additions: 1, deletions: 2 }]
					})
				]
			});
			const diff = await getCodingTaskDiff(db, 'u1', conversationId);
			expect(call).not.toHaveBeenCalledWith('orchestration.getFullThreadDiff', expect.anything());
			expect(
				diff.sources[0].files.map((f) => [f.path, f.status, f.additions, f.deletions])
			).toEqual([
				['a.ts', 'modified', 4, 2],
				['old.ts', 'modified', 0, 0]
			]);
			call.mockReset();
			call.mockResolvedValue({ sources: [] });
		});

		it('still reports other T3 errors', async () => {
			call.mockImplementationOnce(async () => {
				throw new T3ClientError('boom', 'remote');
			});
			await expect(getCodingTaskDiff(db, 'u1', conversationId)).rejects.toMatchObject({
				status: 502
			});
		});
	});
});

describe('latestCheckpointTurn', () => {
	it('picks the latest run with a ready checkpoint', () => {
		expect(
			latestCheckpointTurn({
				checkpoints: [
					{ appRunOrdinal: 1, status: 'ready' },
					{ appRunOrdinal: 4, status: 'ready' },
					{ appRunOrdinal: 5, status: 'error' }
				]
			})
		).toBe(4);
		expect(latestCheckpointTurn({ checkpoints: [{ appRunOrdinal: null, status: 'ready' }] })).toBe(
			0
		);
		expect(latestCheckpointTurn(null)).toBe(0);
	});
});
