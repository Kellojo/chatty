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
	answerSecret: vi.fn<(id: string, secret: string | undefined) => Promise<void>>(async () => {}),
	declineLink: vi.fn<(id: string) => Promise<void>>(async () => {}),
	stop: vi.fn()
};
const t3HttpGet = vi.fn();
const call = vi.fn<(tag: string, payload?: unknown) => Promise<unknown>>(async () => ({}));
vi.doMock('./follower.js', () => ({
	ensureFollower: () => follower,
	getFollower: () => undefined
}));
vi.doMock('./client.js', () => ({
	connectT3: vi.fn(async () => ({ closed: false, call, onClose: () => () => {}, close: vi.fn() })),
	t3HttpGet,
	t3PostBinary: vi.fn(async () => {}),
	T3ClientError: class extends Error {
		constructor(
			message: string,
			readonly kind = 'remote'
		) {
			super(message);
		}
	}
}));
vi.doMock('../events/bus.js', () => ({ publishServerEvent: vi.fn() }));

const { openDatabase } = await import('../db/index.js');
const conversations = await import('../db/repo/conversations.js');
const coding = await import('../db/repo/coding-conversations.js');
const { createMessage } = await import('../db/repo/messages.js');
const { createCodingEnvironment } = await import('../db/repo/coding-environments.js');
const {
	archiveCodingThread,
	browseCodingFolders,
	createCodingProject,
	createCodingDraft,
	createCodingTask,
	getCodingOptions,
	resolveCodingTarget,
	startCodingDraft,
	startCodingTurn,
	respondToCodingRequest,
	updateCodingTaskSettings
} = await import('./tasks.js');
const { T3ClientError } = await import('./client.js');
const { closeAllT3Connections } = await import('./pool.js');
const { startWaitingDrafts } = await import('./draft-starter.js');

type Db = ReturnType<typeof openDatabase>;
let db: Db;
let conversationId: string;
let environmentId: string;

beforeEach(() => {
	for (const fn of Object.values(follower)) fn.mockClear();
	t3HttpGet.mockReset();
	call.mockReset();
	call.mockImplementation(async () => ({}));
	closeAllT3Connections();
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
	environmentId = env.id;
	conversationId = conversations.createConversation(db, 'u1', {
		kind: 'chat',
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
		expect(follower.sendMessage).toHaveBeenCalledWith({
			id: 'm2',
			text: 'hello m2',
			attachments: []
		});
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

describe('startCodingTurn with attachments', () => {
	it('uploads attachments to T3 and sends their references with the message', async () => {
		coding.updateCodingConversation(db, conversationId, { threadId: 't1', status: 'idle' });
		call.mockImplementation(async (tag: unknown) =>
			tag === 'assets.persistChatAttachments'
				? {
						attachments: [
							{ type: 'image', id: 'img-1', name: 'a.png', mimeType: 'image/png', sizeBytes: 3 }
						]
					}
				: {}
		);
		const row = coding.getCodingConversation(db, conversationId)!;
		await startCodingTurn(
			'u1',
			row,
			{
				id: 'm1',
				role: 'user',
				parts: [
					{
						type: 'file',
						mediaType: 'image/png',
						filename: 'a.png',
						url: `data:image/png;base64,${Buffer.from('png').toString('base64')}`
					}
				]
			},
			db
		);
		expect(call.mock.calls[0][0]).toBe('assets.persistChatAttachments');
		expect(call.mock.calls[0][1]).toMatchObject({ threadId: 't1', messageId: 'm1' });
		expect(follower.sendMessage).toHaveBeenCalledWith({
			id: 'm1',
			// Attachments alone get T3's own placeholder text.
			text: expect.stringContaining('attached one or more files'),
			attachments: [
				{ type: 'image', id: 'img-1', name: 'a.png', mimeType: 'image/png', sizeBytes: 3 }
			]
		});
	});

	it("rejects an attachment that isn't this conversation's", async () => {
		const row = coding.getCodingConversation(db, conversationId)!;
		await expect(
			startCodingTurn(
				'u1',
				row,
				{
					id: 'm1',
					role: 'user',
					parts: [
						{ type: 'text', text: 'hi' },
						{ type: 'file', mediaType: 'text/plain', url: '/api/conversations/other/attachments/x' }
					]
				},
				db
			)
		).rejects.toMatchObject({ status: 400 });
		expect(follower.launch).not.toHaveBeenCalled();
	});
});

describe('updateCodingTaskSettings', () => {
	it('only stores the change before the thread exists', async () => {
		const row = await updateCodingTaskSettings(
			'u1',
			conversationId,
			{ providerInstanceId: 'claude', model: 'opus', autonomy: 'supervised' },
			db
		);
		expect(row).toMatchObject({
			provider_instance_id: 'claude',
			model: 'opus',
			runtime_mode: 'approval-required'
		});
		expect(call).not.toHaveBeenCalled();
	});

	it("tells the thread on T3 with T3's own commands", async () => {
		coding.updateCodingConversation(db, conversationId, { threadId: 't1' });
		await updateCodingTaskSettings(
			'u1',
			conversationId,
			{ providerInstanceId: 'claude', model: 'opus', autonomy: 'full-access' },
			db
		);
		expect(call.mock.calls.map((c) => c[1])).toEqual([
			{
				type: 'thread.model-selection.set',
				commandId: expect.any(String),
				threadId: 't1',
				modelSelection: { instanceId: 'claude', model: 'opus' }
			},
			{
				type: 'thread.runtime-mode.set',
				commandId: expect.any(String),
				threadId: 't1',
				runtimeMode: 'full-access'
			}
		]);
		expect(coding.getCodingConversation(db, conversationId)).toMatchObject({
			model: 'opus',
			runtime_mode: 'full-access'
		});
	});

	it('keeps the stored settings when T3 refuses', async () => {
		coding.updateCodingConversation(db, conversationId, { threadId: 't1' });
		call.mockRejectedValueOnce(new Error('nope'));
		await expect(
			updateCodingTaskSettings('u1', conversationId, { autonomy: 'supervised' }, db)
		).rejects.toMatchObject({ status: 500 });
		expect(coding.getCodingConversation(db, conversationId)!.runtime_mode).toBe('auto');
	});

	it('sends nothing when nothing changes', async () => {
		coding.updateCodingConversation(db, conversationId, { threadId: 't1' });
		await updateCodingTaskSettings('u1', conversationId, { autonomy: 'auto' }, db);
		expect(call).not.toHaveBeenCalled();
	});

	it("is not found for another user's task", async () => {
		await expect(
			updateCodingTaskSettings('u2', conversationId, { autonomy: 'auto' }, db)
		).rejects.toMatchObject({ status: 404 });
	});
});

describe('archiveCodingThread', () => {
	it('archives the thread on T3', async () => {
		coding.updateCodingConversation(db, conversationId, { threadId: 't1' });
		await archiveCodingThread('u1', conversationId, db);
		expect(call).toHaveBeenCalledWith('orchestration.dispatchCommand', {
			type: 'thread.archive',
			commandId: expect.any(String),
			threadId: 't1'
		});
	});

	it('is best-effort and skips tasks without a thread', async () => {
		await archiveCodingThread('u1', conversationId, db);
		expect(call).not.toHaveBeenCalled();
		coding.updateCodingConversation(db, conversationId, { threadId: 't1' });
		call.mockRejectedValueOnce(new Error('offline'));
		await expect(archiveCodingThread('u1', conversationId, db)).resolves.toBeUndefined();
		expect(call).toHaveBeenCalledOnce();
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

	it('declines an approval with the typed reply as feedback', async () => {
		coding.updateCodingConversation(db, conversationId, {
			threadId: 't1',
			pendingRequest: {
				kind: 'approval',
				requestId: 'req2',
				title: 'Run a command?',
				detail: null,
				options: [
					{ id: 'accept', label: 'Approve' },
					{ id: 'decline', label: 'Decline' }
				] as never,
				allowFreeText: true,
				createdAt: 0
			}
		});
		const answered = respondToCodingRequest(
			'u1',
			conversationId,
			{ requestId: 'req2', text: 'Run the unit tests only' },
			db
		);
		release();
		await answered;
		expect(follower.respond).toHaveBeenCalledWith({
			requestId: 'req2',
			decision: 'decline',
			feedback: 'Run the unit tests only'
		});
		// Kept for the timeline: T3 only reports that it was declined.
		expect(coding.getCodingRequestAnswers(db, conversationId)).toEqual({
			req2: 'Run the unit tests only'
		});
	});

	describe('secret and link cards', () => {
		const card = (kind: 'secret' | 'link', requestId: string) =>
			coding.updateCodingConversation(db, conversationId, {
				threadId: 't1',
				pendingRequest: {
					kind,
					requestId,
					title: kind === 'secret' ? 'Gitea token' : 'vps',
					detail: null,
					options: [{ id: 'decline', label: 'Decline' }],
					allowFreeText: false,
					createdAt: 0
				}
			});

		it('sends a secret straight to T3, trimmed, without keeping it', async () => {
			card('secret', 's1');
			await respondToCodingRequest('u1', conversationId, { requestId: 's1', text: ' tok ' }, db);
			expect(follower.answerSecret).toHaveBeenCalledWith('s1', 'tok');
			expect(coding.getCodingRequestAnswers(db, conversationId)).toEqual({});
			expect(JSON.stringify(db.prepare('SELECT * FROM coding_conversations').all())).not.toMatch(
				/tok\b/
			);
		});

		it('declines a secret, and refuses an empty one', async () => {
			card('secret', 's2');
			await expect(
				respondToCodingRequest('u1', conversationId, { requestId: 's2', text: '  ' }, db)
			).rejects.toMatchObject({ status: 400 });
			await respondToCodingRequest(
				'u1',
				conversationId,
				{ requestId: 's2', optionId: 'decline' },
				db
			);
			expect(follower.answerSecret).toHaveBeenCalledWith('s2', undefined);
		});

		it('surfaces T3 refusing the answer and lets the user try again', async () => {
			card('secret', 's3');
			follower.answerSecret.mockRejectedValueOnce(
				new T3ClientError(
					"The agent that asked has stopped, so this secret can't be used.",
					'remote'
				)
			);
			await expect(
				respondToCodingRequest('u1', conversationId, { requestId: 's3', text: 'tok' }, db)
			).rejects.toMatchObject({
				status: 502,
				message: "The agent that asked has stopped, so this secret can't be used."
			});
			await respondToCodingRequest('u1', conversationId, { requestId: 's3', text: 'tok' }, db);
			expect(follower.answerSecret).toHaveBeenCalledTimes(2);
		});

		it('only declines a link request, reporting a token without the scope for it', async () => {
			card('link', 'l1');
			await expect(
				respondToCodingRequest('u1', conversationId, { requestId: 'l1', text: 'yes' }, db)
			).rejects.toMatchObject({ status: 400 });
			expect(follower.declineLink).not.toHaveBeenCalled();

			follower.declineLink.mockRejectedValueOnce(
				new T3ClientError('Token is missing the "access:write" scope', 'unauthorized')
			);
			await expect(
				respondToCodingRequest('u1', conversationId, { requestId: 'l1', optionId: 'decline' }, db)
			).rejects.toMatchObject({
				status: 403,
				message: 'Token is missing the "access:write" scope'
			});
			await respondToCodingRequest(
				'u1',
				conversationId,
				{ requestId: 'l1', optionId: 'decline' },
				db
			);
			expect(follower.declineLink).toHaveBeenLastCalledWith('l1');
		});
	});
});

describe('adding an existing folder as a project', () => {
	const browseReply = (parentPath: string) => async (tag: string) =>
		tag === 'filesystem.browse' ? { parentPath, entries: [] } : {};

	it('registers the resolved folder with T3', async () => {
		t3HttpGet.mockResolvedValue({ projects: [] });
		call.mockImplementation(browseReply('/home/u/app'));
		const result = await createCodingProject(
			'u1',
			{ environmentId, title: 'app', path: '~/app' },
			db
		);
		expect(call).toHaveBeenCalledWith('filesystem.browse', { partialPath: '~/app/' });
		expect(call).toHaveBeenCalledWith(
			'projects.mutate',
			expect.objectContaining({
				type: 'project.create',
				title: 'app',
				workspaceRoot: '/home/u/app',
				projectId: result.project.id
			})
		);
		expect(result).toEqual({ project: { id: expect.any(String), title: 'app' }, warning: null });
	});

	it('refuses a folder that is already a project', async () => {
		t3HttpGet.mockResolvedValue({
			projects: [{ id: 'p9', title: 'Existing', workspaceRoot: 'C:\\Code\\App\\' }]
		});
		call.mockImplementation(browseReply('c:\\code\\app'));
		await expect(
			createCodingProject('u1', { environmentId, title: 'app', path: 'c:\\code\\app' }, db)
		).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Existing') });
		expect(call).not.toHaveBeenCalledWith('projects.mutate', expect.anything());
	});

	it('reports a folder that does not exist', async () => {
		call.mockImplementation(async (tag) => {
			if (tag === 'filesystem.browse') throw new T3ClientError('Failed to browse', 'remote');
			return {};
		});
		await expect(
			createCodingProject('u1', { environmentId, title: 'gone', path: '/nope' }, db)
		).rejects.toMatchObject({ status: 400, message: 'No folder at /nope on T3' });
		expect(call).not.toHaveBeenCalledWith('projects.mutate', expect.anything());
	});
});

describe('browseCodingFolders', () => {
	it('lists the folders T3 suggests', async () => {
		call.mockResolvedValue({
			parentPath: '/home/u',
			entries: [{ name: 'code', fullPath: '/home/u/code' }, { name: '' }]
		});
		await expect(browseCodingFolders('u1', environmentId, '~/co', db)).resolves.toEqual({
			parentPath: '/home/u',
			entries: [{ name: 'code', path: '/home/u/code' }]
		});
	});

	it('suggests nothing for a path that cannot be read yet', async () => {
		call.mockRejectedValue(new T3ClientError('Failed to browse', 'remote'));
		await expect(browseCodingFolders('u1', environmentId, '/nop', db)).resolves.toEqual({
			parentPath: null,
			entries: []
		});
	});

	it('still surfaces a missing permission', async () => {
		call.mockRejectedValue(new T3ClientError('Token is missing a scope', 'unauthorized'));
		await expect(browseCodingFolders('u1', environmentId, '~/', db)).rejects.toMatchObject({
			status: 403
		});
	});
});

describe('resolveCodingTarget', () => {
	// Right after a project is added, T3 hasn't filled in `repositoryIdentity` yet.
	const freshProject = { id: 'p1', title: 'App', workspaceRoot: '/home/u/app' };

	it('asks git when T3 has not identified a new repository yet', async () => {
		t3HttpGet.mockResolvedValue({ projects: [freshProject] });
		call.mockImplementation(async (tag) =>
			tag === 'vcs.listRefs' ? { isRepo: true, refs: [] } : {}
		);
		const { project } = await resolveCodingTarget(
			'u1',
			{ environmentId, projectId: 'p1', workspaceMode: 'worktree' },
			db
		);
		expect(call).toHaveBeenCalledWith(
			'vcs.listRefs',
			expect.objectContaining({ cwd: '/home/u/app' })
		);
		expect(project.isGitRepo).toBe(true);
	});

	it('refuses a worktree for a folder without git', async () => {
		t3HttpGet.mockResolvedValue({ projects: [freshProject] });
		call.mockImplementation(async (tag) =>
			tag === 'vcs.listRefs' ? { isRepo: false, refs: [] } : {}
		);
		await expect(
			resolveCodingTarget('u1', { environmentId, projectId: 'p1', workspaceMode: 'worktree' }, db)
		).rejects.toMatchObject({ status: 400 });
	});
});

describe('no project', () => {
	const target = {
		providerInstanceId: 'codex',
		model: 'gpt',
		autonomy: 'auto' as const,
		workspaceMode: 'local' as const
	};

	it("offers it last, in place of T3's own scratch project", async () => {
		t3HttpGet.mockResolvedValue({
			projects: [
				{ id: 'p1', title: 'App', workspaceRoot: '/home/u/app' },
				{ id: 's1', title: 'No project', workspaceRoot: '/home/u/.t3/scratch' }
			]
		});
		call.mockImplementation(async () => ({ settings: {}, providers: [] }));
		const { projects } = await getCodingOptions('u1', environmentId, db);
		expect(projects.map((p) => [p.id, p.title, p.scratch ?? false])).toEqual([
			['p1', 'App', false],
			[':none', 'No project', true]
		]);
	});

	it("starts in T3's scratch project, created on first use", async () => {
		call.mockImplementation(async (tag) =>
			tag === 'projects.ensureScratch' ? { projectId: 's1' } : {}
		);
		const { coding: row } = await createCodingTask(
			'u1',
			{ environmentId, projectId: ':none', ...target },
			db
		);
		expect(t3HttpGet).not.toHaveBeenCalled();
		expect(row.project_id).toBe('s1');
		expect(row.project_title).toBe('No project');
	});

	it('refuses a worktree', async () => {
		await expect(
			resolveCodingTarget(
				'u1',
				{ environmentId, projectId: ':none', workspaceMode: 'worktree' },
				db
			)
		).rejects.toMatchObject({ status: 400 });
	});
});

describe('drafts', () => {
	const target = {
		providerInstanceId: 'codex',
		model: 'gpt',
		autonomy: 'auto' as const,
		workspaceMode: 'local' as const
	};

	function draftWithMessage(projectId = 'p1') {
		const { conversation } = createCodingDraft(
			'u1',
			{ environmentId, projectId, projectTitle: 'App', ...target },
			db
		);
		createMessage(db, {
			id: 'd1',
			conversationId: conversation.id,
			role: 'user',
			parts: [{ type: 'text', text: 'Add a dark mode' }],
			status: 'complete'
		});
		return conversation.id;
	}

	it('saves a draft without reaching the environment', () => {
		const id = draftWithMessage();
		const row = coding.getCodingConversation(db, id)!;
		expect(row.status).toBe('draft');
		expect(row.project_title).toBe('App');
		expect(t3HttpGet).not.toHaveBeenCalled();
		expect(call).not.toHaveBeenCalled();
	});

	it('stays a draft while the environment is unreachable', async () => {
		const id = draftWithMessage();
		t3HttpGet.mockRejectedValue(new T3ClientError('offline', 'remote'));
		await expect(startCodingDraft('u1', id, db)).rejects.toMatchObject({ status: 502 });
		expect(coding.getCodingConversation(db, id)!.status).toBe('draft');
		expect(follower.launch).not.toHaveBeenCalled();
	});

	it('launches with the draft message once started, and only once', async () => {
		const id = draftWithMessage();
		t3HttpGet.mockResolvedValue({
			projects: [{ id: 'p1', title: 'App (renamed)', workspaceRoot: '/home/u/app' }]
		});
		const started = startCodingDraft('u1', id, db);
		await vi.waitFor(() => expect(follower.launch).toHaveBeenCalledOnce());
		await expect(startCodingDraft('u1', id, db)).rejects.toMatchObject({ status: 409 });
		release();
		const row = await started;
		expect(follower.launch).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: 'p1',
				message: expect.objectContaining({ id: 'd1', text: 'Add a dark mode' })
			})
		);
		expect(row.project_title).toBe('App (renamed)');
		expect(row.thread_id).not.toBeNull();
	});

	it("resolves a draft without a project to T3's scratch project when started", async () => {
		const id = draftWithMessage(':none');
		expect(coding.getCodingConversation(db, id)!.project_title).toBe('No project');
		call.mockImplementation(async (tag) =>
			tag === 'projects.ensureScratch' ? { projectId: 's1' } : {}
		);
		const started = startCodingDraft('u1', id, db);
		await vi.waitFor(() => expect(follower.launch).toHaveBeenCalledOnce());
		release();
		expect((await started).project_id).toBe('s1');
	});
});

describe('auto-starting drafts', () => {
	const target = {
		providerInstanceId: 'codex',
		model: 'gpt',
		autonomy: 'auto' as const,
		workspaceMode: 'local' as const
	};

	function draft(text: string | null = 'Add a dark mode') {
		const { conversation } = createCodingDraft(
			'u1',
			{ environmentId, projectId: 'p1', projectTitle: 'App', ...target },
			db
		);
		if (text !== null) {
			createMessage(db, {
				id: `m-${conversation.id}`,
				conversationId: conversation.id,
				role: 'user',
				parts: [{ type: 'text', text }],
				status: 'complete'
			});
		}
		return conversation.id;
	}

	it('starts a waiting draft once the environment answers', async () => {
		const id = draft();
		expect(coding.toPublic(coding.getCodingConversation(db, id)!).autoStart).toBe(true);
		t3HttpGet.mockResolvedValue({ projects: [{ id: 'p1', title: 'App', workspaceRoot: '/a' }] });
		follower.launch.mockResolvedValueOnce(undefined);
		await startWaitingDrafts(db);
		expect(follower.launch).toHaveBeenCalledOnce();
		expect(coding.getCodingConversation(db, id)!.status).not.toBe('draft');
	});

	it('keeps waiting while offline, trying each environment once per pass', async () => {
		const a = draft();
		const b = draft();
		t3HttpGet.mockRejectedValue(new T3ClientError('offline', 'remote'));
		await startWaitingDrafts(db);
		expect(t3HttpGet).toHaveBeenCalledOnce();
		for (const id of [a, b]) {
			const row = coding.getCodingConversation(db, id)!;
			expect([row.status, row.auto_start, row.last_error]).toEqual(['draft', 1, null]);
		}
	});

	it('skips drafts whose message has not arrived, and ones turned off', async () => {
		draft(null);
		const off = draft();
		coding.setCodingDraftAutoStart(db, off, false);
		await startWaitingDrafts(db);
		expect(t3HttpGet).not.toHaveBeenCalled();
	});

	it('stops auto-starting a draft whose project is gone, saying why', async () => {
		const id = draft();
		t3HttpGet.mockResolvedValue({ projects: [] });
		await startWaitingDrafts(db);
		const row = coding.getCodingConversation(db, id)!;
		expect(row.status).toBe('draft');
		expect(row.auto_start).toBe(0);
		expect(row.last_error).toMatch(/not found/i);
		expect(coding.setCodingDraftAutoStart(db, id, true)).toBe(true);
		expect(coding.getCodingConversation(db, id)!.last_error).toBeNull();
	});
});
