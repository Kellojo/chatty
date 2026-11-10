import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/index.js';
import { createAgent, type AgentRow } from '../db/repo/agents.js';
import { createAgentRun, finishAgentRun, getAgentRun } from '../db/repo/agent-runs.js';
import {
	createConversation,
	getConversation,
	settleConversation,
	softDeleteConversation
} from '../db/repo/conversations.js';
import { createMessage } from '../db/repo/messages.js';
import {
	completeRunTurn,
	dismissRunQuestion,
	onRunConversationSettled,
	onRunConversationUnsettled,
	runHeader,
	runTurnContext,
	SETTLED_DISMISS_REASON
} from './run-lifecycle.js';

let db: Db;
let agent: AgentRow;

beforeEach(() => {
	db = openDatabase(':memory:');
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
		 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'), ('u2', 'd@e.f', 'D', 0, 0, 0, 'user')`
	).run();
	agent = createAgent(db, 'u1', { name: 'inbox', systemPrompt: 'x', triggerType: 'manual' });
});

function dispatched() {
	const conversation = createConversation(db, 'u1', { origin: 'dispatch', agentId: agent.id });
	createMessage(db, {
		conversationId: conversation.id,
		role: 'user',
		parts: [{ type: 'text', text: 'go' }],
		status: 'complete'
	});
	const run = createAgentRun(db, {
		agentId: agent.id,
		userId: 'u1',
		trigger: 'schedule',
		conversationId: conversation.id
	});
	return { conversation, run };
}

const complete = {
	status: 'complete' as const,
	error: null,
	abortReason: null,
	openAskUser: null
};

describe('runTurnContext', () => {
	it('lets a visible run ask unless another run of the agent already waits', () => {
		const first = dispatched();
		expect(runTurnContext(db, agent, first.run, { resumed: false }).askUser).toBe(true);
		finishAgentRun(db, first.run.id, 'awaiting_input');
		// The waiting run itself may ask a follow-up when resumed...
		expect(runTurnContext(db, agent, first.run, { resumed: true }).askUser).toBe(true);
		// ...another run may not.
		const second = dispatched();
		const ctx = runTurnContext(db, agent, second.run, { resumed: false });
		expect(ctx.askUser).toBe(false);
		expect(ctx.header).toContain('Do not ask the user questions');
	});

	it('limits approval-only agents to asking before risky actions', () => {
		const header = runHeader({ name: 'a', can_ask: 'approvals' }, 'manual', {
			askUser: true,
			resumed: false
		});
		expect(header).toContain('irreversible or risky');
	});
});

describe('completeRunTurn', () => {
	it('maps abort reasons to run errors', () => {
		const { conversation, run } = dispatched();
		const ctx = runTurnContext(db, agent, run, { resumed: false });
		completeRunTurn(db, ctx, conversation, {
			...complete,
			status: 'aborted',
			abortReason: 'superseded'
		});
		expect(getAgentRun(db, run.id)).toMatchObject({
			status: 'failed',
			error: 'Superseded by your message'
		});
	});

	it('settles a routine success, but not a run the user answered', () => {
		const routine = dispatched();
		completeRunTurn(
			db,
			runTurnContext(db, agent, routine.run, { resumed: false }),
			routine.conversation,
			complete
		);
		expect(getConversation(db, 'u1', routine.conversation.id)!.settled_at).not.toBeNull();

		const answered = dispatched();
		completeRunTurn(
			db,
			runTurnContext(db, agent, answered.run, { resumed: true }),
			answered.conversation,
			complete
		);
		expect(getConversation(db, 'u1', answered.conversation.id)!.settled_at).toBeNull();
	});

	it('dismisses a question asked after the chat went to the trash', () => {
		const { conversation, run } = dispatched();
		softDeleteConversation(db, 'u1', conversation.id);
		const asked = { ...complete, openAskUser: { toolCallId: 'c1', question: 'Archive?' } };
		const status = completeRunTurn(
			db,
			runTurnContext(db, agent, run, { resumed: false }),
			conversation,
			asked
		);
		expect(status).toBe('dismissed');
		expect(getAgentRun(db, run.id)!.status).toBe('dismissed');
	});

	it('brings a settled chat back when its run asks a question', () => {
		const { conversation, run } = dispatched();
		settleConversation(db, 'u1', conversation.id);
		const asked = { ...complete, openAskUser: { toolCallId: 'c1', question: 'Archive?' } };
		completeRunTurn(db, runTurnContext(db, agent, run, { resumed: false }), conversation, asked);
		expect(getAgentRun(db, run.id)!.status).toBe('awaiting_input');
		expect(getConversation(db, 'u1', conversation.id)!.settled_at).toBeNull();
	});

	it("keeps only the agent's latest failure in the active list", () => {
		const older = dispatched();
		finishAgentRun(db, older.run.id, 'failed', 'boom');
		const newer = dispatched();
		completeRunTurn(
			db,
			runTurnContext(db, agent, newer.run, { resumed: false }),
			newer.conversation,
			{
				...complete,
				status: 'failed',
				error: 'boom again'
			}
		);
		expect(getConversation(db, 'u1', older.conversation.id)!.settled_at).not.toBeNull();
		expect(getConversation(db, 'u1', newer.conversation.id)!.settled_at).toBeNull();
	});
});

describe('dismissRunQuestion', () => {
	it("dismisses the owner's waiting run only", () => {
		const { conversation, run } = dispatched();
		finishAgentRun(db, run.id, 'awaiting_input');
		expect(dismissRunQuestion(db, 'u2', conversation.id, 'x')).toBe(false);
		expect(dismissRunQuestion(db, 'u1', conversation.id, 'Dismissed: chat settled')).toBe(true);
		expect(getAgentRun(db, run.id)).toMatchObject({
			status: 'dismissed',
			error: 'Dismissed: chat settled'
		});
		expect(dismissRunQuestion(db, 'u1', conversation.id, 'again')).toBe(false);
	});
});

describe('settling and unsettling a dispatched chat', () => {
	function waiting() {
		const { conversation, run } = dispatched();
		createMessage(db, {
			conversationId: conversation.id,
			role: 'assistant',
			parts: [
				{
					type: 'tool-ask_user',
					toolCallId: 'c1',
					state: 'input-available',
					input: { question: 'Archive?', kind: 'confirm' }
				}
			],
			status: 'complete'
		});
		finishAgentRun(db, run.id, 'awaiting_input');
		return { conversation, run };
	}

	it('dismisses the question on settle and restores it on unsettle', () => {
		const { conversation, run } = waiting();
		onRunConversationSettled(db, 'u1', conversation.id);
		expect(getAgentRun(db, run.id)).toMatchObject({
			status: 'dismissed',
			error: SETTLED_DISMISS_REASON
		});
		expect(onRunConversationUnsettled(db, 'u1', conversation.id)).toBe(true);
		expect(getAgentRun(db, run.id)).toMatchObject({ status: 'awaiting_input', error: null });
	});

	it('keeps questions dismissed some other way dismissed', () => {
		const { conversation, run } = waiting();
		dismissRunQuestion(db, 'u1', conversation.id, 'Dismissed: no answer within 7 days');
		expect(onRunConversationUnsettled(db, 'u1', conversation.id)).toBe(false);
		expect(getAgentRun(db, run.id)!.status).toBe('dismissed');
	});

	it('does not reopen once the question is no longer the latest message', () => {
		const { conversation, run } = waiting();
		onRunConversationSettled(db, 'u1', conversation.id);
		createMessage(db, {
			conversationId: conversation.id,
			role: 'user',
			parts: [{ type: 'text', text: 'never mind' }],
			status: 'complete'
		});
		expect(onRunConversationUnsettled(db, 'u1', conversation.id)).toBe(false);
		expect(getAgentRun(db, run.id)!.status).toBe('dismissed');
	});

	it('does not reopen while another run of the agent waits for an answer', () => {
		const first = waiting();
		onRunConversationSettled(db, 'u1', first.conversation.id);
		waiting();
		expect(onRunConversationUnsettled(db, 'u1', first.conversation.id)).toBe(false);
	});
});
