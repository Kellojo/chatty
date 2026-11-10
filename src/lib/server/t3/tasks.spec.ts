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
const call = vi.fn<(tag: string, payload?: unknown) => Promise<unknown>>(async () => ({}));
vi.doMock('./follower.js', () => ({
	ensureFollower: () => follower,
	getFollower: () => undefined
}));
vi.doMock('./client.js', () => ({
	connectT3: vi.fn(async () => ({ closed: false, call, onClose: () => () => {}, close: vi.fn() })),
	t3HttpGet,
	t3PostBinary: vi.fn(async () => {}),
	T3ClientError: class extends Error {}
}));
vi.doMock('../events/bus.js', () => ({ publishServerEvent: vi.fn() }));

const { openDatabase } = await import('../db/index.js');
const conversations = await import('../db/repo/conversations.js');
const coding = await import('../db/repo/coding-conversations.js');
const { createCodingEnvironment } = await import('../db/repo/coding-environments.js');
const { archiveCodingThread, startCodingTurn, respondToCodingRequest, updateCodingTaskSettings } =
	await import('./tasks.js');
const { closeAllT3Connections } = await import('./pool.js');

type Db = ReturnType<typeof openDatabase>;
let db: Db;
let conversationId: string;

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
});
