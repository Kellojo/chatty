import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

// Whether a reply is streaming into a chat, controlled per test.
const streaming = new Set<string>();
vi.doMock('./streams.js', () => ({ hasActiveStream: (id: string) => streaming.has(id) }));

const { withCodingTaskProposals, reportFinishedProposal } = await import('./coding-proposals.js');
const { getDb } = await import('../db/index.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { createCodingEnvironment } = await import('../db/repo/coding-environments.js');
const { createCodingConversation } = await import('../db/repo/coding-conversations.js');
const { listMessages } = await import('../db/repo/messages.js');
const { publishServerEvent } = await import('../events/bus.js');
const { createCodingTask, CodingTaskError } = await import('../t3/tasks.js');
type UIMessage = import('$lib/types.js').UIMessage;

let envId: string;

beforeAll(() => {
	const db = getDb();
	for (const id of ['u1', 'u2']) {
		db.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (?, ?, 'A', 0, 0, 0, 'user')`
		).run(id, `${id}@example.com`);
	}
	envId = createCodingEnvironment(db, 'u1', {
		name: 'devbox',
		baseUrl: 'https://devbox.example',
		token: 'token'
	}).id;
});

/** A chat with a proposal (`toolCallId`) and, optionally, the task started from it. */
function setup(toolCallId: string, opts: { started?: boolean } = {}) {
	const db = getDb();
	const chat = createConversation(db, 'u1', { title: 'Main chat' });
	if (!opts.started) return { chat, taskId: null };
	const task = createConversation(db, 'u1', { kind: 'chat', mode: 'agent', title: 'Fix login' });
	createCodingConversation(db, {
		conversationId: task.id,
		environmentId: envId,
		projectId: 'p-1',
		projectTitle: 'ai-chat',
		providerInstanceId: 'codex',
		model: 'gpt',
		runtimeMode: 'full-access',
		workspaceMode: 'worktree',
		baseBranch: 'main',
		proposal: { conversationId: chat.id, toolCallId }
	});
	return { chat, taskId: task.id };
}

function proposalMessage(toolCallId: string): UIMessage {
	return {
		id: 'm1',
		role: 'assistant',
		parts: [
			{
				type: 'dynamic-tool',
				toolName: 'propose_coding_task',
				toolCallId,
				state: 'output-available',
				input: { title: 'Fix login', prompt: 'Fix it' },
				output: {
					content: [{ type: 'text', text: JSON.stringify({ proposed: true, note: 'old' }) }]
				}
			}
		]
	} as UIMessage;
}

const toolBody = (message: UIMessage) => {
	const part = message.parts[0] as { output: { content: { text: string }[] } };
	return JSON.parse(part.output.content[0].text) as Record<string, unknown>;
};

const finished = (conversationId: string) =>
	({
		type: 'coding.thread.finished',
		conversationId,
		status: 'completed',
		branch: 'fix-login',
		prUrl: 'https://github.com/o/r/pull/42'
	}) as const;

describe('withCodingTaskProposals', () => {
	it('tells the model a proposal has not been started', () => {
		const { chat } = setup('call-a');
		const [message] = withCodingTaskProposals(getDb(), chat.id, [proposalMessage('call-a')]);
		expect(toolBody(message)).toMatchObject({ proposed: true, startedTask: null });
		expect(toolBody(message).note).toMatch(/Not started/);
	});

	it("adds the started task's id and status", () => {
		const { chat, taskId } = setup('call-b', { started: true });
		const [message] = withCodingTaskProposals(getDb(), chat.id, [proposalMessage('call-b')]);
		expect(toolBody(message).startedTask).toMatchObject({
			conversationId: taskId,
			title: 'Fix login',
			project: 'ai-chat',
			status: 'starting'
		});
	});

	it('turns notices into text and leaves other messages alone', () => {
		const plain = { id: 'm0', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as UIMessage;
		const notice = {
			id: 'm2',
			role: 'assistant',
			parts: [
				{
					type: 'data-coding-task-notice',
					data: {
						conversationId: 't1',
						title: 'Fix login',
						projectTitle: 'ai-chat',
						status: 'failed'
					}
				}
			]
		} as UIMessage;
		const [same, text] = withCodingTaskProposals(getDb(), 'none', [plain, notice]);
		expect(same).toBe(plain);
		expect(text.parts).toEqual([
			{ type: 'text', text: expect.stringMatching(/^\[Notice\] Coding task "Fix login".*failed/) }
		]);
	});
});

describe('reportFinishedProposal', () => {
	const notices = (chatId: string) =>
		listMessages(getDb(), chatId).filter((m) => m.parts.includes('data-coding-task-notice'));

	it('posts one notice to the proposing chat, the first time the task finishes', () => {
		const { chat, taskId } = setup('call-c', { started: true });
		reportFinishedProposal('u1', finished(taskId!));
		reportFinishedProposal('u1', finished(taskId!));
		const posted = notices(chat.id);
		expect(posted).toHaveLength(1);
		expect(JSON.parse(posted[0].parts)[0].data).toMatchObject({
			conversationId: taskId,
			status: 'completed',
			prUrl: 'https://github.com/o/r/pull/42'
		});
	});

	it('waits for a reply streaming into the chat to finish', async () => {
		const { chat, taskId } = setup('call-d', { started: true });
		streaming.add(chat.id);
		reportFinishedProposal('u1', finished(taskId!));
		expect(notices(chat.id)).toHaveLength(0);
		streaming.delete(chat.id);
		publishServerEvent('u1', { type: 'chat.stream.finished', conversationId: chat.id });
		await new Promise((r) => setTimeout(r, 0));
		expect(notices(chat.id)).toHaveLength(1);
	});

	it('ignores tasks that were not proposed', () => {
		const { chat } = setup('call-e');
		reportFinishedProposal('u1', finished(chat.id));
		expect(notices(chat.id)).toHaveLength(0);
	});
});

describe('starting a proposed task', () => {
	const input = {
		environmentId: 'env',
		projectId: 'p-1',
		providerInstanceId: 'codex',
		model: 'gpt',
		autonomy: 'auto',
		workspaceMode: 'worktree'
	} as const;

	it('refuses a second task for the same proposal', async () => {
		const { chat } = setup('call-f', { started: true });
		const start = createCodingTask('u1', input, getDb(), {
			proposal: { conversationId: chat.id, toolCallId: 'call-f' }
		});
		await expect(start).rejects.toBeInstanceOf(CodingTaskError);
		await expect(start).rejects.toMatchObject({ status: 409 });
	});

	it("refuses to link a task to another user's chat", async () => {
		const { chat } = setup('call-g');
		await expect(
			createCodingTask('u2', input, getDb(), {
				proposal: { conversationId: chat.id, toolCallId: 'call-g' }
			})
		).rejects.toMatchObject({ status: 404 });
	});
});
