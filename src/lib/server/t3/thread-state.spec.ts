import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const publishServerEvent = vi.fn();
vi.doMock('../events/bus.js', () => ({ publishServerEvent }));
/** Commands sent to T3; each call waits on `nextCall` when set. */
const dispatched: Record<string, unknown>[] = [];
let nextCall: Promise<void> | null = null;
const fakeConnection = {
	closed: false,
	onClose: () => () => {},
	call: vi.fn(async (_tag: string, command: Record<string, unknown>) => {
		dispatched.push(command);
		const wait = nextCall;
		nextCall = null;
		if (wait) await wait;
		return {};
	}),
	close: vi.fn()
};
const { T3ClientError } = await import('./client.js');
vi.doMock('./client.js', () => ({
	connectT3: vi.fn(async () => fakeConnection),
	T3ClientError
}));

const { openDatabase } = await import('../db/index.js');
const conversations = await import('../db/repo/conversations.js');
const coding = await import('../db/repo/coding-conversations.js');
const { createMessage } = await import('../db/repo/messages.js');
const { createCodingEnvironment } = await import('../db/repo/coding-environments.js');
const {
	MAX_THREAD_TITLE_CHARS,
	mergeValue,
	pushThreadState,
	reconcileThreadState,
	remoteThreadState,
	threadSettled
} = await import('./thread-state.js');

type Db = ReturnType<typeof openDatabase>;
type Remote = Parameters<typeof reconcileThreadState>[3];
let db: Db;
let conversationId: string;

beforeEach(() => {
	publishServerEvent.mockClear();
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
	coding.updateCodingConversation(db, conversationId, { threadId: 't1' });
});

const none: Remote = { title: null, pinned: null, settled: null, read: null };
const reconcile = (remote: Partial<Remote>) =>
	reconcileThreadState(db, 'u1', conversationId, { ...none, ...remote });
const local = () => conversations.getConversation(db, 'u1', conversationId)!;
const agreed = () => coding.getCodingConversation(db, conversationId)!;
const unread = () => conversations.listUnreadChatIds(db, 'u1').includes(conversationId);
const setReadAt = (at: number) => conversations.setConversationReadAt(db, 'u1', conversationId, at);

describe('threadSettled', () => {
	it('reads settledAt, falling back to the settled flag', () => {
		expect(threadSettled({ settledAt: '2026-11-07T10:00:00Z' })).toBe(true);
		expect(threadSettled({ settledAt: null, settledOverride: 'active' })).toBe(false);
		expect(threadSettled({ settled: true })).toBe(true);
		expect(threadSettled({ title: 'x' })).toBeNull();
		expect(threadSettled(null)).toBeNull();
	});
});

describe('remoteThreadState', () => {
	it('reads the synced fields off a shell thread', () => {
		expect(
			remoteThreadState({
				title: ' Fix it ',
				pinnedAt: '2026-11-07T10:00:00Z',
				settledAt: null,
				lastVisitedAt: null,
				latestRunCompletedAt: '2026-11-07T11:00:00Z',
				activeRunId: null
			})
		).toEqual({
			title: 'Fix it',
			pinned: true,
			settled: false,
			read: { visitedAt: 0, completedAt: Date.parse('2026-11-07T11:00:00Z'), running: false }
		});
	});

	it('caps the title length', () => {
		const { title } = remoteThreadState({ title: `  ${'x'.repeat(5000)}` });
		expect(title).toBe('x'.repeat(MAX_THREAD_TITLE_CHARS));
	});

	it('leaves out what the record does not say, and takes runs from the caller', () => {
		expect(remoteThreadState({ title: '' })).toEqual(none);
		expect(
			remoteThreadState(
				{ lastVisitedAt: '2026-11-07T10:00:00Z' },
				{ completedAt: 5, running: true }
			).read
		).toEqual({ visitedAt: Date.parse('2026-11-07T10:00:00Z'), completedAt: 5, running: true });
	});
});

describe('mergeValue', () => {
	it('lets T3 win unless only Chatty moved', () => {
		expect(mergeValue('a', null, 'a')).toBe('agree');
		expect(mergeValue('a', null, 'b')).toBe('adopt');
		expect(mergeValue('a', 'a', 'b')).toBe('adopt');
		expect(mergeValue('b', 'a', 'a')).toBe('push');
		expect(mergeValue('c', 'a', 'b')).toBe('adopt');
		expect(mergeValue('a', 'a', 'a')).toBeNull();
	});
});

describe('settled', () => {
	it('adopts the remote state on first comparison', () => {
		expect(reconcile({ settled: true })).toBe(false);
		expect(local().settled_at).not.toBeNull();
		expect(agreed().remote_settled).toBe(1);
		expect(publishServerEvent).toHaveBeenCalledWith('u1', {
			type: 'conversation.settle_changed',
			conversationIds: [conversationId],
			settled: true
		});
	});

	it('applies a remote unsettle', () => {
		reconcile({ settled: true });
		expect(reconcile({ settled: false })).toBe(false);
		expect(local().settled_at).toBeNull();
		expect(agreed().remote_settled).toBe(0);
	});

	it('asks to push a local change the remote has not seen', () => {
		reconcile({ settled: false });
		conversations.settleConversation(db, 'u1', conversationId, 'manual');
		expect(reconcile({ settled: false })).toBe(true);
		expect(local().settled_at).not.toBeNull();
		expect(agreed().remote_settled).toBe(0);
	});

	it('is a no-op when both sides agree', () => {
		reconcile({ settled: false });
		publishServerEvent.mockClear();
		expect(reconcile({ settled: false })).toBe(false);
		expect(publishServerEvent).not.toHaveBeenCalled();
	});

	it('lets a remote change win over a concurrent local one', () => {
		reconcile({ settled: false });
		conversations.settleConversation(db, 'u1', conversationId, 'manual');
		coding.updateCodingConversation(db, conversationId, { remoteSettled: true });
		expect(reconcile({ settled: false })).toBe(false);
		expect(local().settled_at).toBeNull();
	});
});

describe('title', () => {
	it('adopts a rename on T3 without bumping the conversation', () => {
		reconcile({ title: 'Fix the build' });
		const updatedAt = local().updated_at;
		expect(reconcile({ title: 'Fix the CI build' })).toBe(false);
		expect(local()).toMatchObject({ title: 'Fix the CI build', updated_at: updatedAt });
		expect(agreed().remote_title).toBe('Fix the CI build');
		expect(publishServerEvent).toHaveBeenCalledWith('u1', {
			type: 'conversation.updated',
			conversationId
		});
	});

	it('adopts T3 generated title on first comparison', () => {
		reconcile({ title: 'Generated title' });
		expect(local().title).toBe('Generated title');
	});

	it('asks to push a rename in Chatty', () => {
		reconcile({ title: 'Fix the build' });
		conversations.updateConversation(db, 'u1', conversationId, { title: 'Renamed' });
		expect(reconcile({ title: 'Fix the build' })).toBe(true);
		expect(local().title).toBe('Renamed');
	});

	it('keeps a long local title when T3 holds its capped form', () => {
		const long = 'y'.repeat(MAX_THREAD_TITLE_CHARS + 50);
		const capped = long.slice(0, MAX_THREAD_TITLE_CHARS);
		reconcile({ title: 'Fix the build' });
		conversations.updateConversation(db, 'u1', conversationId, { title: long });
		expect(reconcile({ title: 'Fix the build' })).toBe(true);
		// What a successful push records (it sends the capped title).
		coding.updateCodingConversation(db, conversationId, { remoteTitle: capped });
		expect(reconcile({ title: capped })).toBe(false);
		expect(local().title).toBe(long);
		expect(agreed().remote_title).toBe(capped);
	});
});

describe('pinned', () => {
	it('adopts a pin on T3 and asks to push a local unpin', () => {
		reconcile({ pinned: false });
		reconcile({ pinned: true });
		expect(local().pinned).toBe(1);
		expect(agreed().remote_pinned).toBe(1);
		conversations.setConversationPinned(db, 'u1', conversationId, false);
		expect(reconcile({ pinned: true })).toBe(true);
		expect(local().pinned).toBe(0);
	});
});

describe('read state', () => {
	const reply = (createdAt: number) =>
		createMessage(db, { conversationId, role: 'assistant', parts: [], createdAt });

	it('marks read once T3 visited after the latest run', () => {
		setReadAt(500);
		reply(1001);
		expect(unread()).toBe(true);
		reconcile({ read: { visitedAt: 3000, completedAt: 2000, running: false } });
		expect(unread()).toBe(false);
		expect(local().last_read_at).toBe(3000);
		expect(agreed().remote_visited_at).toBe(3000);
	});

	it('keeps the unread state while a run is going on T3', () => {
		setReadAt(500);
		reply(1001);
		reconcile({ read: { visitedAt: 3000, completedAt: null, running: true } });
		expect(unread()).toBe(true);
	});

	it('asks to push a read in Chatty after the run completed', () => {
		reply(1001);
		setReadAt(2500);
		expect(reconcile({ read: { visitedAt: 900, completedAt: 2000, running: false } })).toBe(true);
		expect(unread()).toBe(false);
	});

	it('marks unread when the run completed after Chatty last looked', () => {
		reply(1001);
		setReadAt(1500); // looked mid-run
		expect(reconcile({ read: { visitedAt: 1500, completedAt: 2000, running: false } })).toBe(false);
		expect(unread()).toBe(true);
	});

	it('adopts "mark unread" on T3 even after Chatty read it', () => {
		reply(1001);
		setReadAt(3000);
		reconcile({ read: { visitedAt: 3000, completedAt: 2000, running: false } });
		expect(unread()).toBe(false);
		// T3 moves lastVisitedAt to just before the run completed.
		expect(reconcile({ read: { visitedAt: 1999, completedAt: 2000, running: false } })).toBe(false);
		expect(unread()).toBe(true);
		expect(agreed().remote_visited_at).toBe(1999);
	});
});

describe('pushThreadState', () => {
	beforeEach(() => {
		dispatched.length = 0;
		nextCall = null;
		coding.updateCodingConversation(db, conversationId, {
			remoteSettled: false,
			remotePinned: false,
			remoteTitle: 'Fix the build'
		});
	});

	it('sends only what differs from the agreed state, and records it', async () => {
		conversations.settleConversation(db, 'u1', conversationId, 'manual');
		await pushThreadState(db, 'u1', [conversationId]);
		expect(dispatched.map((c) => c.type)).toEqual(['thread.settle']);
		expect(agreed().remote_settled).toBe(1);
		await pushThreadState(db, 'u1', [conversationId]);
		expect(dispatched).toHaveLength(1);
	});

	it('pushes again after the push in flight when the state changes meanwhile', async () => {
		let release!: () => void;
		nextCall = new Promise<void>((resolve) => (release = resolve));
		conversations.settleConversation(db, 'u1', conversationId, 'manual');
		const first = pushThreadState(db, 'u1', [conversationId]);
		await vi.waitFor(() => expect(dispatched).toHaveLength(1));

		// Renamed while the settle is still being sent: queued, not sent twice at once.
		conversations.updateConversation(db, 'u1', conversationId, { title: 'Renamed' });
		await pushThreadState(db, 'u1', [conversationId]);
		expect(dispatched).toHaveLength(1);

		release();
		await first;
		expect(dispatched.map((c) => c.type)).toEqual(['thread.settle', 'thread.metadata.update']);
		expect(dispatched[1]).toMatchObject({ title: 'Renamed' });
		expect(agreed().remote_title).toBe('Renamed');
	});
});
