import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { openDatabase } = await import('../db/index.js');
const conversations = await import('../db/repo/conversations.js');
const coding = await import('../db/repo/coding-conversations.js');
const { createCodingEnvironment } = await import('../db/repo/coding-environments.js');
const { importableThreads, importBudget, MAX_IMPORTS_PER_PASS, MAX_THREAD_CONVERSATIONS_PER_ENV } =
	await import('./thread-sync.js');

const since = Date.parse('2026-11-01T00:00:00Z');

const thread = (overrides: Record<string, unknown> = {}) => ({
	id: 't1',
	projectId: 'p1',
	title: 'Fix the build',
	providerInstanceId: 'codex',
	modelSelection: { instanceId: 'codex', model: 'gpt-5' },
	runtimeMode: 'full-access',
	branch: 't3/fix-build',
	worktreePath: '/w/fix-build',
	lineage: { parentThreadId: null, relationshipToParent: null },
	activeRunId: null,
	pendingRuntimeRequest: null,
	archivedAt: null,
	settledAt: null,
	createdAt: '2026-11-02T10:00:00Z',
	updatedAt: '2026-11-02T11:00:00Z',
	...overrides
});
const shell = (threads: unknown[], projects: unknown[] = [{ id: 'p1', title: 'Chatty' }]) => ({
	projects,
	threads,
	archivedThreads: []
});

describe('importableThreads', () => {
	it('maps a top-level thread to an import', () => {
		expect(importableThreads(shell([thread()]), { known: new Set(), since })).toEqual([
			{
				threadId: 't1',
				projectId: 'p1',
				projectTitle: 'Chatty',
				title: 'Fix the build',
				providerInstanceId: 'codex',
				model: 'gpt-5',
				runtimeMode: 'full-access',
				workspaceMode: 'worktree',
				branch: 't3/fix-build',
				status: 'idle',
				settled: false,
				pinned: false,
				visitedAt: 0,
				createdAt: Date.parse('2026-11-02T10:00:00Z'),
				updatedAt: Date.parse('2026-11-02T11:00:00Z')
			}
		]);
	});

	it('skips known, subagent, delegated, archived, stale and orphaned threads', () => {
		const threads = [
			thread({ id: 'known' }),
			thread({ id: 'sub', lineage: { relationshipToParent: 'subagent' } }),
			thread({ id: 'delegated', delegatedFrom: { threadId: 'x' } }),
			thread({ id: 'archived', archivedAt: '2026-11-03T00:00:00Z' }),
			thread({ id: 'stale', updatedAt: '2026-10-01T00:00:00Z' }),
			thread({ id: 'orphan', projectId: 'gone' }),
			thread({ id: 'fork', lineage: { relationshipToParent: 'fork' } })
		];
		const result = importableThreads(shell(threads), { known: new Set(['known']), since });
		expect(result.map((t) => t.threadId)).toEqual(['fork']);
	});

	it('caps thread and project titles', () => {
		const [t] = importableThreads(
			shell([thread({ title: 'a'.repeat(1000) })], [{ id: 'p1', title: 'b'.repeat(1000) }]),
			{ known: new Set(), since }
		);
		expect(t.title).toHaveLength(200);
		expect(t.projectTitle).toHaveLength(200);
	});

	it('derives provisional status, settled state and workspace mode', () => {
		const [running, waiting, background, settled] = importableThreads(
			shell([
				thread({ id: 'a', activeRunId: 'r1', updatedAt: '2026-11-02T01:00:00Z' }),
				thread({ id: 'b', pendingRuntimeRequest: { id: 'q' }, updatedAt: '2026-11-02T02:00:00Z' }),
				thread({
					id: 'd',
					pendingBackgroundTasks: [{ taskId: 'x', kind: 'monitor', awaited: true }],
					updatedAt: '2026-11-02T03:00:00Z'
				}),
				thread({ id: 'c', settledAt: '2026-11-04T00:00:00Z', worktreePath: null })
			]),
			{ known: new Set(), since }
		);
		expect(running.status).toBe('running');
		expect(waiting.status).toBe('awaiting_input');
		expect(background.status).toBe('waiting');
		expect(settled).toMatchObject({ settled: true, workspaceMode: 'local' });
	});
});

describe('importCodingConversation', () => {
	type Db = ReturnType<typeof openDatabase>;
	let db: Db;
	let environmentId: string;

	beforeEach(() => {
		db = openDatabase(':memory:');
		const now = Date.now();
		db.prepare(
			`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'u1', 'u1@example.com', 0, ?, ?, 'user')`
		).run(now, now);
		environmentId = createCodingEnvironment(db, 'u1', {
			name: 'T3',
			baseUrl: 'http://t3.test',
			token: 'token'
		}).id;
	});

	const importInput = (settled = false, threadId = 't1') => ({
		userId: 'u1',
		environmentId,
		threadId,
		projectId: 'p1',
		projectTitle: 'Chatty',
		title: 'Fix the build',
		providerInstanceId: 'codex',
		model: 'gpt-5',
		runtimeMode: 'full-access',
		workspaceMode: 'worktree' as const,
		baseBranch: null,
		branch: 't3/fix-build',
		status: 'idle' as const,
		settled,
		pinned: true,
		visitedAt: 1500,
		createdAt: 1000,
		updatedAt: 2000
	});
	const importOne = (settled = false, threadId = 't1') =>
		coding.importCodingConversation(db, importInput(settled, threadId))!;

	it('creates the conversation with the thread timestamps, settled, pinned and read state', () => {
		const id = importOne(true);
		const conversation = conversations.getConversation(db, 'u1', id)!;
		expect(conversation).toMatchObject({
			title: 'Fix the build',
			created_at: 1000,
			updated_at: 2000,
			settled_at: 2000,
			pinned: 1,
			last_read_at: 1500
		});
		expect(coding.getCodingConversation(db, id)).toMatchObject({
			thread_id: 't1',
			branch: 't3/fix-build',
			status: 'idle',
			remote_settled: 1,
			remote_title: 'Fix the build',
			remote_pinned: 1,
			remote_visited_at: 1500
		});
		expect(coding.listKnownThreadIds(db, environmentId)).toEqual(new Set(['t1']));
	});

	it('stops importing once the environment holds the maximum of thread conversations', () => {
		expect(importBudget(db, environmentId)).toBe(MAX_IMPORTS_PER_PASS);
		for (let i = 0; i < MAX_THREAD_CONVERSATIONS_PER_ENV - 3; i++) importOne(false, `t${i}`);
		expect(coding.countThreadCodingConversations(db, environmentId)).toBe(
			MAX_THREAD_CONVERSATIONS_PER_ENV - 3
		);
		expect(importBudget(db, environmentId)).toBe(3);
		const open = Array.from({ length: 3 }, (_, i) => importOne(false, `x${i}`));
		expect(importBudget(db, environmentId)).toBe(0);
		// Settled conversations don't count.
		importOne(true, 'done');
		expect(importBudget(db, environmentId)).toBe(0);
		conversations.settleConversation(db, 'u1', open[0]);
		expect(importBudget(db, environmentId)).toBe(1);
		importOne(false, 'again');
		expect(importBudget(db, environmentId)).toBe(0);
		// Deleted conversations don't count.
		const id = importOne(false, 'extra');
		conversations.purgeConversation(db, id);
		expect(importBudget(db, environmentId)).toBe(0);
		conversations.purgeConversation(db, open[1]);
		expect(importBudget(db, environmentId)).toBe(1);
	});

	it("knows the owner's threads on their other environments, but not other users' threads", () => {
		importOne();
		const second = createCodingEnvironment(db, 'u1', {
			name: 'Same server',
			baseUrl: 'http://192.168.0.2:3773',
			token: 'token'
		}).id;
		expect(coding.listKnownThreadIds(db, second)).toEqual(new Set(['t1']));
		expect(coding.knownThreadIdsAmong(db, second, ['t1', 'nope'])).toEqual(new Set(['t1']));
		db.prepare(
			`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u2', 'u2', 'u2@example.com', 0, 0, 0, 'user')`
		).run();
		const foreign = createCodingEnvironment(db, 'u2', {
			name: 'T3',
			baseUrl: 'http://t3.test',
			token: 'token'
		}).id;
		expect(coding.listKnownThreadIds(db, foreign)).toEqual(new Set());
		expect(coding.knownThreadIdsAmong(db, foreign, ['t1'])).toEqual(new Set());
	});

	it('lists the tasks of just the given threads', () => {
		const a = importOne(false, 'ta');
		importOne(false, 'tb');
		const gone = importOne(false, 'tc');
		conversations.softDeleteConversation(db, 'u1', gone);
		const rows = coding.listThreadCodingConversationsFor(db, environmentId, ['ta', 'tc', 'zz']);
		expect(rows.map((r) => [r.conversation_id, r.user_id])).toEqual([[a, 'u1']]);
		expect(coding.listThreadCodingConversationsFor(db, environmentId, [])).toEqual([]);
	});

	it('relinks conversations of a removed environment to one serving their thread', () => {
		const id = importOne();
		db.prepare('DELETE FROM coding_environments WHERE id = ?').run(environmentId);
		expect(coding.getCodingConversation(db, id)?.environment_id).toBeNull();
		const readded = createCodingEnvironment(db, 'u1', {
			name: 'T3',
			baseUrl: 'http://t3.test',
			token: 'token'
		}).id;
		expect(coding.relinkOrphanedThreads(db, readded, new Set(['other']))).toEqual([]);
		expect(coding.relinkOrphanedThreads(db, readded, new Set(['t1']))).toEqual([id]);
		expect(coding.getCodingConversation(db, id)?.environment_id).toBe(readded);
		expect(coding.listKnownThreadIds(db, readded)).toEqual(new Set(['t1']));
	});

	it('remembers the thread after its conversation is purged', () => {
		const id = importOne();
		conversations.purgeConversation(db, id);
		expect(coding.getCodingConversation(db, id)).toBeUndefined();
		expect(coding.listKnownThreadIds(db, environmentId)).toEqual(new Set(['t1']));
		expect(coding.knownThreadIdsAmong(db, environmentId, ['t1', 't2'])).toEqual(new Set(['t1']));
	});

	it('does not import a thread that is already linked, even on another environment', () => {
		const first = importOne();
		const count = () =>
			(
				db
					.prepare('SELECT COUNT(*) AS n FROM coding_conversations WHERE thread_id = ?')
					.get('t1') as {
					n: number;
				}
			).n;
		expect(coding.importCodingConversation(db, { ...importInput(), environmentId })).toBeNull();
		const second = createCodingEnvironment(db, 'u1', {
			name: 'Same server',
			baseUrl: 'http://192.168.0.2:3773',
			token: 'token'
		}).id;
		expect(
			coding.importCodingConversation(db, { ...importInput(), environmentId: second })
		).toBeNull();
		// Deleted (not purged) conversations keep their thread too.
		conversations.softDeleteConversation(db, 'u1', first);
		expect(coding.importCodingConversation(db, { ...importInput(), environmentId })).toBeNull();
		expect(count()).toBe(1);
	});
});
