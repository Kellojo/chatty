import { describe, expect, it } from 'vitest';
import {
	activeRun,
	applyStreamItem,
	emptyThreadState,
	renderRun,
	replyMessageId,
	summarizeTask
} from './projection.js';

const run = (overrides: Record<string, unknown> = {}) => ({
	id: 'run-1',
	ordinal: 1,
	status: 'running',
	userMessageId: 'msg-1',
	requestedAt: '2026-11-07T10:00:00.000Z',
	...overrides
});

function snapshot(projection: Record<string, unknown>, snapshotSequence = 10) {
	return { kind: 'snapshot', snapshotSequence, projection };
}

function event(sequence: number, type: string, payload: unknown) {
	return {
		kind: 'event',
		sequence,
		event: { id: `e${sequence}`, threadId: 't1', type, occurredAt: '', payload }
	};
}

describe('applyStreamItem', () => {
	it('loads a snapshot and upserts full records from events', () => {
		const state = emptyThreadState();
		applyStreamItem(
			state,
			snapshot({
				thread: { id: 't1', title: 'Fix login', branch: 'chatty/fix-login' },
				runs: [run()],
				messages: [{ id: 'msg-1', role: 'user', text: 'Fix the login bug' }],
				turnItems: [],
				runtimeRequests: []
			})
		);
		expect(state.lastSequence).toBe(10);
		expect(activeRun(state)?.id).toBe('run-1');

		applyStreamItem(state, event(11, 'run.updated', run({ status: 'completed' })));
		expect(state.lastSequence).toBe(11);
		expect(activeRun(state)).toBeNull();

		applyStreamItem(
			state,
			event(12, 'thread.pull-request-link-updated', {
				linkedPullRequest: { url: 'https://github.com/o/r/pull/7', number: 7 }
			})
		);
		expect(summarizeTask(state)).toMatchObject({
			status: 'idle',
			branch: 'chatty/fix-login',
			prUrl: 'https://github.com/o/r/pull/7',
			title: 'Fix login'
		});
	});

	it('ignores unknown event types but still advances the sequence', () => {
		const state = emptyThreadState();
		expect(applyStreamItem(state, event(5, 'something.new', {}))).toBe(false);
		expect(state.lastSequence).toBe(5);
		expect(applyStreamItem(state, 'garbage')).toBe(false);
	});
});

describe('renderRun', () => {
	it('renders text, reasoning and tool items in ordinal order', () => {
		const state = emptyThreadState();
		applyStreamItem(
			state,
			snapshot({
				runs: [run()],
				turnItems: [
					{
						id: 'i3',
						runId: 'run-1',
						ordinal: 3,
						type: 'assistant_message',
						status: 'running',
						text: 'Done',
						streaming: true
					},
					{
						id: 'i1',
						runId: 'run-1',
						ordinal: 1,
						type: 'reasoning',
						status: 'completed',
						text: 'Thinking'
					},
					{
						id: 'i2',
						runId: 'run-1',
						ordinal: 2,
						type: 'command_execution',
						status: 'completed',
						input: 'pnpm test',
						exitCode: 0,
						outputOmitted: true
					},
					{
						id: 'i4',
						runId: 'run-1',
						ordinal: 4,
						type: 'file_change',
						status: 'running',
						fileName: 'a.ts',
						changes: [{ operation: 'update', path: 'src/a.ts' }]
					},
					{
						id: 'u',
						runId: 'run-1',
						ordinal: 0,
						type: 'user_message',
						status: 'completed',
						text: 'hi'
					},
					{
						id: 'other',
						runId: 'run-2',
						ordinal: 1,
						type: 'assistant_message',
						status: 'completed',
						text: 'x'
					}
				]
			})
		);
		const entries = renderRun(state, run(), new Map([['i2', 'all tests passed']]));
		expect(entries.map((e) => e.key)).toEqual(['i1', 'i2', 'i3', 'i4']);
		expect(entries[0].part).toMatchObject({ type: 'reasoning', text: 'Thinking', state: 'done' });
		expect(entries[1].part).toMatchObject({
			type: 'dynamic-tool',
			toolName: 'run_command',
			state: 'output-available',
			input: { command: 'pnpm test' },
			output: { exitCode: 0, output: 'all tests passed' }
		});
		expect(entries[2]).toMatchObject({ final: false, part: { type: 'text', state: 'streaming' } });
		expect(entries[3].part).toMatchObject({
			toolName: 'edit_files',
			state: 'input-available',
			input: { files: ['src/a.ts'] }
		});
	});

	it('marks failed commands as errors', () => {
		const state = emptyThreadState();
		applyStreamItem(
			state,
			snapshot({
				runs: [run()],
				turnItems: [
					{
						id: 'c',
						runId: 'run-1',
						ordinal: 1,
						type: 'command_execution',
						status: 'completed',
						input: 'false',
						exitCode: 1,
						outputIndicatesFailure: true
					}
				]
			})
		);
		expect(renderRun(state, run())[0].part).toMatchObject({ state: 'output-error' });
	});
});

describe('summarizeTask', () => {
	it('surfaces a pending approval with its offered decisions', () => {
		const state = emptyThreadState();
		applyStreamItem(
			state,
			snapshot({
				runs: [run({ status: 'waiting' })],
				runtimeRequests: [{ id: 'req-1', kind: 'command', status: 'pending' }],
				turnItems: [
					{
						id: 'a1',
						runId: 'run-1',
						ordinal: 1,
						type: 'approval_request',
						status: 'waiting',
						requestId: 'req-1',
						prompt: 'Run `rm -rf dist`?',
						reason: 'Clean build output',
						options: [
							{ decision: 'accept', label: 'Run it' },
							{ decision: 'decline', label: 'No' }
						]
					}
				]
			})
		);
		const summary = summarizeTask(state);
		expect(summary.status).toBe('awaiting_input');
		expect(summary.pendingRequest).toMatchObject({
			requestId: 'req-1',
			kind: 'approval',
			title: 'Run `rm -rf dist`?',
			detail: 'Clean build output',
			options: [
				{ id: 'accept', label: 'Run it' },
				{ id: 'decline', label: 'No' }
			]
		});
	});

	it('surfaces a question with its options and question id', () => {
		const state = emptyThreadState();
		applyStreamItem(
			state,
			snapshot({
				runs: [run({ status: 'waiting' })],
				runtimeRequests: [{ id: 'req-2', kind: 'user_input', status: 'pending' }],
				turnItems: [
					{
						id: 'q1',
						runId: 'run-1',
						ordinal: 1,
						type: 'user_input_request',
						status: 'waiting',
						requestId: 'req-2',
						questions: [
							{
								id: 'q',
								header: 'Database',
								question: 'Which DB?',
								options: [{ label: 'Postgres' }, { label: 'SQLite', value: 'sqlite' }]
							}
						]
					}
				]
			})
		);
		expect(summarizeTask(state).pendingRequest).toMatchObject({
			kind: 'question',
			questionId: 'q',
			title: 'Which DB?',
			options: [
				{ id: 'Postgres', label: 'Postgres' },
				{ id: 'sqlite', label: 'SQLite' }
			]
		});
	});

	it('maps the last run status when nothing is pending', () => {
		const state = emptyThreadState();
		expect(summarizeTask(state).status).toBe('starting');
		applyStreamItem(state, snapshot({ runs: [run({ status: 'failed' })] }));
		expect(summarizeTask(state).status).toBe('failed');
		applyStreamItem(state, event(11, 'run.updated', run({ status: 'interrupted' })));
		expect(summarizeTask(state).status).toBe('interrupted');
	});
});

describe('replyMessageId', () => {
	it('derives the reply id from the user message that started the run', () => {
		expect(replyMessageId(run())).toBe('msg-1:reply');
		expect(replyMessageId(run({ userMessageId: undefined }))).toBe('t3run:run-1');
	});
});
