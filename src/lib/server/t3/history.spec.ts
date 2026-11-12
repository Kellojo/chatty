import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryThread } from './history.js';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { openDatabase } = await import('../db/index.js');
const conversations = await import('../db/repo/conversations.js');
const coding = await import('../db/repo/coding-conversations.js');
const { createCodingEnvironment } = await import('../db/repo/coding-environments.js');
const { bulkImportSelection, historyThreads } = await import('./history.js');

const thread = (overrides: Record<string, unknown> = {}) => ({
	id: 't1',
	projectId: 'p1',
	title: 'Fix the build',
	modelSelection: { instanceId: 'codex', model: 'gpt-5' },
	runtimeMode: 'full-access',
	branch: 't3/fix-build',
	worktreePath: '/w/fix-build',
	activeRunId: null,
	pendingRuntimeRequest: null,
	archivedAt: null,
	settledAt: null,
	createdAt: '2024-01-02T10:00:00Z',
	updatedAt: '2024-01-02T11:00:00Z',
	...overrides
});

describe('historyThreads', () => {
	const none = { linked: new Set<string>(), dismissed: new Set<string>() };

	it('lists old and archived threads newest first, without a cutoff', () => {
		const shell = {
			projects: [{ id: 'p1', title: 'Chatty' }],
			threads: [thread({ id: 'old', updatedAt: '2020-05-01T00:00:00Z' }), thread({ id: 'new' })],
			archivedThreads: [
				thread({
					id: 'arch',
					archivedAt: '2024-02-01T00:00:00Z',
					updatedAt: '2024-02-01T00:00:00Z'
				})
			]
		};
		const result = historyThreads(shell, none);
		expect(result.map((t) => [t.threadId, t.archived])).toEqual([
			['arch', true],
			['new', false],
			['old', false]
		]);
	});

	it('skips linked, subagent and orphaned threads and flags dismissed ones', () => {
		const shell = {
			projects: [{ id: 'p1', title: 'Chatty' }],
			threads: [
				thread({ id: 'linked' }),
				thread({ id: 'sub', lineage: { relationshipToParent: 'subagent' } }),
				thread({ id: 'orphan', projectId: 'gone' }),
				thread({ id: 'gone', deletedAt: '2024-01-03T00:00:00Z' }),
				thread({ id: 'dismissed' })
			],
			archivedThreads: []
		};
		const result = historyThreads(shell, {
			linked: new Set(['linked']),
			dismissed: new Set(['dismissed'])
		});
		expect(result.map((t) => [t.threadId, t.dismissed])).toEqual([['dismissed', true]]);
	});
});

describe('bulkImportSelection', () => {
	const item = (threadId: string, overrides: Partial<HistoryThread> = {}): HistoryThread => ({
		threadId,
		projectId: 'p1',
		projectTitle: 'Chatty',
		title: threadId,
		providerInstanceId: 'codex',
		model: 'gpt-5',
		runtimeMode: 'full-access',
		workspaceMode: 'local',
		branch: null,
		status: 'idle',
		settled: false,
		pinned: false,
		visitedAt: 0,
		createdAt: 0,
		updatedAt: 0,
		archived: false,
		dismissed: false,
		...overrides
	});

	it('skips archived and dismissed threads', () => {
		const { threads, skipped } = bulkImportSelection(
			[item('live'), item('archived', { archived: true }), item('gone', { dismissed: true })],
			10
		);
		expect(threads.map((t) => t.threadId)).toEqual(['live']);
		expect(skipped).toBe(0);
	});

	it('caps open threads at the room left, newest first, but not settled ones', () => {
		const { threads, skipped } = bulkImportSelection(
			[item('a'), item('b', { settled: true }), item('c'), item('d')],
			2
		);
		expect(threads.map((t) => t.threadId)).toEqual(['a', 'b', 'c']);
		expect(skipped).toBe(1);
	});
});

describe('history repo helpers', () => {
	let db: ReturnType<typeof openDatabase>;
	let environmentId: string;

	beforeEach(() => {
		db = openDatabase(':memory:');
		db.prepare(
			`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'u1', 'u1@example.com', 0, 0, 0, 'user')`
		).run();
		environmentId = createCodingEnvironment(db, 'u1', {
			name: 'T3',
			baseUrl: 'http://t3.test',
			token: 'token'
		}).id;
	});

	it('tells linked from dismissed threads and forgets a dismissal', () => {
		const input = {
			userId: 'u1',
			environmentId,
			projectId: 'p1',
			projectTitle: 'Chatty',
			title: 'Task',
			providerInstanceId: 'codex',
			model: 'gpt-5',
			runtimeMode: 'full-access',
			workspaceMode: 'worktree' as const,
			baseBranch: null,
			branch: null,
			status: 'idle' as const,
			settled: false,
			pinned: false,
			visitedAt: 0,
			createdAt: 1000,
			updatedAt: 2000
		};
		coding.importCodingConversation(db, { ...input, threadId: 'kept' });
		const purged = coding.importCodingConversation(db, { ...input, threadId: 'purged' })!;
		conversations.purgeConversation(db, purged);

		expect(coding.listLinkedThreadIds(db, environmentId)).toEqual(new Set(['kept']));
		expect(coding.listDismissedThreadIds(db, environmentId)).toEqual(new Set(['purged']));
		coding.undismissThreads(db, environmentId, ['purged']);
		expect(coding.listDismissedThreadIds(db, environmentId)).toEqual(new Set());
	});
});
