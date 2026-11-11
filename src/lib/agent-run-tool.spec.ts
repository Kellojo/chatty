import { describe, expect, it } from 'vitest';
import {
	agentRunPhase,
	describeRefusal,
	latestRunReply,
	parseAgentRunOutput,
	replyPreview
} from './agent-run-tool.js';

const run = {
	id: 'r1',
	agentId: 'a1',
	userId: 'u1',
	trigger: 'manual',
	status: 'success',
	conversationId: 'c1',
	error: null,
	startedAt: 1000,
	endedAt: 5000
};

const mcp = (body: unknown, isError = false) => ({
	content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }],
	isError
});

describe('parseAgentRunOutput', () => {
	it('reads the run, agent and reply', () => {
		const parsed = parseAgentRunOutput(
			mcp({
				run,
				agent: { id: 'a1', name: 'Meal Planner' },
				runPath: '/agents/a1/runs/r1',
				chatPath: null,
				result: 'Planned 5 dinners.',
				question: null
			})
		);
		expect(parsed?.agent.name).toBe('Meal Planner');
		expect(parsed?.result).toBe('Planned 5 dinners.');
		expect(parsed?.runPath).toBe('/agents/a1/runs/r1');
		expect(parsed?.truncated).toBe(false);
	});

	it('reads older results that only carried the run', () => {
		const parsed = parseAgentRunOutput(mcp({ run: { ...run, status: 'running' } }));
		expect(parsed?.agent).toEqual({ id: 'a1', name: null });
		expect(parsed?.runPath).toBe('/agents/a1/runs/r1');
	});

	it('ignores errors and malformed output', () => {
		expect(parseAgentRunOutput(mcp('error: agent not found', true))).toBeNull();
		expect(parseAgentRunOutput(mcp('not json'))).toBeNull();
		expect(parseAgentRunOutput(mcp({ run: { ...run, status: 'exploded' } }))).toBeNull();
		expect(parseAgentRunOutput(undefined)).toBeNull();
	});
});

describe('agentRunPhase', () => {
	it('tells a waited-on run from one left in the background', () => {
		const running = { status: 'running' as const, error: null };
		expect(agentRunPhase(running, { callRunning: true })).toBe('running');
		expect(agentRunPhase(running, { callRunning: false })).toBe('background');
		expect(agentRunPhase(null, { callRunning: true })).toBe('starting');
	});

	it('maps finished runs, and a stop by the user', () => {
		const at = (
			status: 'success' | 'failed' | 'awaiting_input' | 'dismissed',
			error = null as string | null
		) => agentRunPhase({ status, error }, { callRunning: false });
		expect(at('success')).toBe('done');
		expect(at('awaiting_input')).toBe('asking');
		expect(at('dismissed')).toBe('dismissed');
		expect(at('failed', 'boom')).toBe('failed');
		expect(at('failed', 'Stopped by user')).toBe('stopped');
	});
});

describe('latestRunReply', () => {
	it("returns the last assistant message's text and open question", () => {
		const reply = latestRunReply([
			{ role: 'user', parts: [{ type: 'text', text: 'Go' }] },
			{
				role: 'assistant',
				parts: [
					{ type: 'reasoning', text: 'hmm' },
					{ type: 'text', text: 'Two options.' },
					{
						type: 'tool-ask_user',
						toolCallId: 'q',
						state: 'input-available',
						input: { question: 'Which one?', kind: 'text' }
					}
				]
			}
		]);
		expect(reply).toEqual({ text: 'Two options.', question: 'Which one?' });
	});

	it('is empty until the agent has replied', () => {
		expect(latestRunReply([{ role: 'user', parts: [] }])).toEqual({ text: null, question: null });
	});
});

describe('replyPreview', () => {
	it('skips headings markers, rules and markdown syntax', () => {
		expect(replyPreview('## Plan\n\n---\n- **Monday:** [Pasta](https://x)')).toBe('Monday: Pasta');
		expect(replyPreview('## Plan\n\n| Day | Dish |\n| --- | --- |\n\nAdded 4 recipes.')).toBe(
			'Added 4 recipes.'
		);
		expect(replyPreview('Added **4 recipes** (assigned to *Rewe*, snake_case kept).')).toBe(
			'Added 4 recipes (assigned to Rewe, snake_case kept).'
		);
		// Only a heading and a table: the heading is better than nothing.
		expect(replyPreview('## Plan\n\n| Day | Dish |')).toBe('Plan');
		expect(replyPreview('---\n\n1. `Soup` first')).toBe('Soup first');
		expect(replyPreview('   ')).toBeNull();
	});
});

describe('describeRefusal', () => {
	it('words a busy agent for the user and keeps the run to watch', () => {
		expect(
			describeRefusal(
				'error: agent is already running (run r-9); call get_agent_run with this runId and wait: true to wait for it'
			)
		).toEqual({ reason: 'Already running: a run of this agent hasn’t finished yet', runId: 'r-9' });
	});

	it('passes other reasons through, capitalised', () => {
		expect(describeRefusal('error: agent not found')).toEqual({
			reason: 'Agent not found',
			runId: null
		});
		expect(describeRefusal('')).toEqual({ reason: 'The call failed', runId: null });
	});
});
