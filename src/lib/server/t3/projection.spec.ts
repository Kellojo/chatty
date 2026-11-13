import { describe, expect, it } from 'vitest';
import {
	activeRun,
	applyStreamItem,
	changedRuns,
	copyThreadRecords,
	emptyThreadState,
	hasRunningSubagent,
	hasUnloadedOutput,
	itemsOfType,
	MAX_PART_CHARS,
	MAX_RUN_PARTS,
	MAX_THREAD_RECORDS,
	OMITTED_PARTS_NOTICE,
	renderRun,
	replyMessageId,
	runItems,
	runItemsEvicted,
	storedOutputs,
	streamItemRun,
	summarizeTask,
	TRUNCATED_MARKER
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

describe('streamItemRun', () => {
	it('names the run an event can change', () => {
		expect(streamItemRun(event(1, 'run.updated', { id: 'r1' }))).toBe('r1');
		expect(streamItemRun(event(1, 'turn-item.updated', { id: 'i1', runId: 'r2' }))).toBe('r2');
		expect(streamItemRun(event(1, 'thread.updated', { title: 'x' }))).toBeNull();
		expect(streamItemRun(event(1, 'runtime-request.updated', { id: 'q1' }))).toBe('all');
		expect(streamItemRun(snapshot({ runs: [] }))).toBe('all');
	});

	it('routes messages and requests to the run showing them', () => {
		const state = emptyThreadState();
		applyStreamItem(
			state,
			snapshot({
				runs: [run(), run({ id: 'run-2', ordinal: 2, userMessageId: 'msg-2' })],
				turnItems: [
					{ id: 'a1', runId: 'run-2', ordinal: 1, type: 'approval_request', requestId: 'q1' }
				]
			})
		);
		const routed = (type: string, payload: unknown) =>
			streamItemRun(event(20, type, payload), state);
		expect(routed('message.updated', { id: 'msg-2' })).toBe('run-2');
		expect(routed('message.updated', { id: 'msg-9' })).toBeNull();
		expect(routed('message.updated', { id: 'msg-9', runId: 'run-1' })).toBe('run-1');
		expect(routed('runtime-request.updated', { id: 'q1' })).toBe('run-2');
		expect(routed('runtime-request.updated', { id: 'q9' })).toBeNull();
		expect(routed('runtime-request.updated', { id: 'q9', runId: 'run-1' })).toBe('run-1');
	});
});

describe('turn item indexes', () => {
	it('follow items that move between runs, change type or are evicted', () => {
		const state = emptyThreadState();
		applyStreamItem(
			state,
			snapshot({
				runs: [run()],
				turnItems: [{ id: 'i1', runId: 'run-1', ordinal: 1, type: 'reasoning', requestId: 'q1' }]
			})
		);
		expect(runItems(state, 'run-1').map((i) => i.id)).toEqual(['i1']);
		expect(state.itemByRequest.get('q1')?.id).toBe('i1');

		applyStreamItem(
			state,
			event(11, 'turn-item.updated', { id: 'i1', runId: 'run-2', type: 'subagent' })
		);
		expect(runItems(state, 'run-1')).toEqual([]);
		expect(runItems(state, 'run-2').map((i) => i.id)).toEqual(['i1']);
		expect(itemsOfType(state, 'reasoning')).toEqual([]);
		expect(itemsOfType(state, 'subagent').map((i) => i.id)).toEqual(['i1']);
		expect(state.itemByRequest.has('q1')).toBe(false);

		for (let i = 0; i < MAX_THREAD_RECORDS; i++) {
			applyStreamItem(state, event(12 + i, 'turn-item.updated', { id: `x${i}`, runId: 'run-3' }));
		}
		expect(runItems(state, 'run-2')).toEqual([]);
		expect(state.itemsByRun.has('run-2')).toBe(false);
		expect(runItems(state, 'run-3')).toHaveLength(MAX_THREAD_RECORDS);
	});
});

describe('changedRuns', () => {
	const base = () => ({
		runs: [run(), run({ id: 'run-2', ordinal: 2, userMessageId: 'msg-2' })],
		messages: [{ id: 'msg-2', text: 'Hi' }],
		turnItems: [
			{ id: 'i1', runId: 'run-1', ordinal: 1, type: 'assistant_message', text: 'a' },
			{ id: 'i2', runId: 'run-2', ordinal: 1, type: 'approval_request', requestId: 'q1' }
		],
		runtimeRequests: [{ id: 'q1', status: 'pending' }]
	});
	const diff = (next: Record<string, unknown>) => {
		const state = emptyThreadState();
		applyStreamItem(state, snapshot(base()));
		const before = copyThreadRecords(state);
		applyStreamItem(state, snapshot(next, 20));
		return changedRuns(before, state);
	};

	it('is empty for the same thread again', () => {
		expect(diff(base())).toEqual(new Set());
	});

	it('names runs whose run, items, user message or requests changed', () => {
		const b = base();
		expect(diff({ ...b, runs: [run({ status: 'completed' }), b.runs[1]] })).toEqual(
			new Set(['run-1'])
		);
		expect(diff({ ...b, turnItems: [{ ...b.turnItems[0], text: 'ab' }, b.turnItems[1]] })).toEqual(
			new Set(['run-1'])
		);
		expect(diff({ ...b, messages: [{ id: 'msg-2', text: 'Hello' }] })).toEqual(new Set(['run-2']));
		expect(diff({ ...b, runtimeRequests: [{ id: 'q1', status: 'resolved' }] })).toEqual(
			new Set(['run-2'])
		);
		expect(diff({ ...b, turnItems: [b.turnItems[1]] })).toEqual(new Set(['run-1']));
	});
});

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

	it('reports the pull request state T3 last observed', () => {
		const state = emptyThreadState();
		applyStreamItem(
			state,
			snapshot({ thread: { id: 't1' }, runs: [run({ status: 'completed' })] })
		);
		expect(summarizeTask(state)).toMatchObject({ prUrl: null, prState: null });

		// A PR T3 found for the branch counts as already created.
		applyStreamItem(
			state,
			event(11, 'thread.updated', {
				branchPullRequest: { url: 'https://github.com/o/r/pull/7', state: 'open', isDraft: true }
			})
		);
		expect(summarizeTask(state)).toMatchObject({
			prUrl: 'https://github.com/o/r/pull/7',
			prState: 'draft'
		});

		// A bare linked reference takes its state from T3's cached snapshot.
		applyStreamItem(
			state,
			event(12, 'thread.pull-request-link-updated', {
				linkedPullRequest: { url: 'https://github.com/o/r/pull/7', number: 7 },
				pullRequests: [
					{
						url: 'https://github.com/o/r/pull/7',
						snapshot: JSON.stringify({ state: 'closed', mergedAt: '2026-11-07T00:00:00Z' })
					}
				]
			})
		);
		expect(summarizeTask(state).prState).toBe('merged');
	});

	it('ignores unknown event types but still advances the sequence', () => {
		const state = emptyThreadState();
		expect(applyStreamItem(state, event(5, 'something.new', {}))).toBe(false);
		expect(state.lastSequence).toBe(5);
		expect(applyStreamItem(state, 'garbage')).toBe(false);
	});

	it('ignores events it has already applied', () => {
		const state = emptyThreadState();
		applyStreamItem(state, snapshot({ runs: [run({ status: 'completed' })] }));
		expect(applyStreamItem(state, event(10, 'run.updated', run()))).toBe(false);
		expect(applyStreamItem(state, event(9, 'run.updated', run()))).toBe(false);
		expect(activeRun(state)).toBeNull();
		expect(state.lastSequence).toBe(10);
		expect(applyStreamItem(state, event(11, 'run.updated', run()))).toBe(true);
		expect(activeRun(state)?.id).toBe('run-1');
	});

	it('keeps its state when a snapshot has no projection', () => {
		const state = emptyThreadState();
		applyStreamItem(state, snapshot({ runs: [run()] }));
		expect(applyStreamItem(state, { kind: 'snapshot', snapshotSequence: 12 })).toBe(false);
		expect(state.runs.size).toBe(1);
		expect(state.lastSequence).toBe(10);
	});
});

describe('renderRun', () => {
	it("adds the user's stored answer to resolved requests only", () => {
		const state = emptyThreadState();
		applyStreamItem(
			state,
			snapshot({
				runs: [run({ status: 'waiting' })],
				runtimeRequests: [
					{ id: 'q-done', kind: 'user_input', status: 'resolved', decision: 'answered' },
					{ id: 'q-open', kind: 'user_input', status: 'pending' }
				],
				turnItems: [
					{ id: 'i1', runId: 'run-1', ordinal: 1, type: 'user_input_request', requestId: 'q-done' },
					{ id: 'i2', runId: 'run-1', ordinal: 2, type: 'user_input_request', requestId: 'q-open' }
				]
			})
		);
		const [done, open] = renderRun(state, state.runs.get('run-1')!, new Map(), {
			'q-done': 'Postgres',
			'q-open': 'not sent yet'
		}).map((e) => e.part as { output?: Record<string, unknown> });
		expect(done.output).toMatchObject({ status: 'answered', answer: 'Postgres' });
		expect(open.output?.answer).toBeUndefined();
	});

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

	it('keeps the name, arguments and result of agent tools, subagents and checkpoints', () => {
		const state = emptyThreadState();
		applyStreamItem(
			state,
			snapshot({
				runs: [run({ status: 'completed' })],
				turnItems: [
					{
						id: 'd1',
						runId: 'run-1',
						ordinal: 1,
						type: 'dynamic_tool',
						status: 'completed',
						title: 'Read C:/repo/a.ts',
						toolName: 'Read',
						input: { file_path: 'C:/repo/a.ts' },
						output: 'contents'
					},
					{
						id: 'd2',
						runId: 'run-1',
						ordinal: 2,
						type: 'dynamic_tool',
						status: 'completed',
						toolName: 'Grep',
						input: { pattern: 'todo' },
						outputOmitted: true
					},
					{
						id: 's1',
						runId: 'run-1',
						ordinal: 3,
						type: 'subagent',
						status: 'completed',
						title: 'Review',
						prompt: 'Review the diff',
						startedAt: '2026-11-07T10:00:00.000Z',
						completedAt: '2026-11-07T10:01:30.000Z',
						result: 'Looks good'
					},
					{
						id: 'c1',
						runId: 'run-1',
						ordinal: 4,
						type: 'checkpoint',
						status: 'completed',
						files: [
							{ path: 'a.ts', kind: 'modified', additions: 3, deletions: 1 },
							{ path: 'b.ts', kind: 'added', additions: 5, deletions: 0 }
						]
					}
				]
			})
		);
		const parts = renderRun(state, run(), new Map([['d2', 'a.ts:1: todo']])).map((e) => e.part);
		expect(parts[0]).toMatchObject({
			toolName: 'Read',
			input: { file_path: 'C:/repo/a.ts' },
			output: 'contents'
		});
		expect(parts[1]).toMatchObject({ toolName: 'Grep', output: 'a.ts:1: todo' });
		expect(parts[2]).toMatchObject({
			toolName: 'subagent',
			input: {
				description: 'Review',
				prompt: 'Review the diff',
				startedAt: Date.parse('2026-11-07T10:00:00.000Z'),
				completedAt: Date.parse('2026-11-07T10:01:30.000Z')
			},
			output: 'Looks good'
		});
		expect(parts[3]).toMatchObject({
			toolName: 'checkpoint',
			input: {
				files: ['a.ts', 'b.ts'],
				changes: [
					{ path: 'a.ts', kind: 'modified', additions: 3, deletions: 1 },
					{ path: 'b.ts', kind: 'added', additions: 5, deletions: 0 }
				]
			},
			output: { additions: 8, deletions: 1 }
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

	it('does not show cancelled or interrupted tools as successful', () => {
		const state = emptyThreadState();
		const tool = (id: string, ordinal: number, status: string) => ({
			id,
			runId: 'run-1',
			ordinal,
			type: 'dynamic_tool',
			status,
			toolName: 'Read'
		});
		applyStreamItem(
			state,
			snapshot({
				runs: [run({ status: 'interrupted' })],
				turnItems: [tool('a', 1, 'cancelled'), tool('b', 2, 'interrupted')]
			})
		);
		expect(renderRun(state, run()).map((e) => e.part)).toMatchObject([
			{ state: 'output-error', errorText: 'Cancelled' },
			{ state: 'output-error', errorText: 'Interrupted' }
		]);
	});

	it('shows the text of notifications and unknown item types', () => {
		const state = emptyThreadState();
		const text = 'Command "pnpm dev" and subagent "Reviewer" were stopped';
		applyStreamItem(
			state,
			snapshot({
				runs: [run()],
				turnItems: [
					{ id: 'n', runId: 'run-1', ordinal: 1, type: 'notification', text },
					{
						id: 'u',
						runId: 'run-1',
						ordinal: 2,
						type: 'future_thing',
						status: 'completed',
						title: 'Something new',
						text: 'It happened'
					}
				]
			})
		);
		expect(renderRun(state, run()).map((e) => e.part)).toMatchObject([
			{ toolName: 'notice', state: 'output-available', input: { text } },
			{
				toolName: 'Something new',
				state: 'output-available',
				input: { kind: 'future_thing', text: 'It happened' }
			}
		]);
	});
});

describe('summarizeTask', () => {
	describe('waiting on background work', () => {
		const done = run({ status: 'completed', completedAt: '2026-11-07T10:05:00.000Z' });
		const statusOf = (projection: Record<string, unknown>) => {
			const state = emptyThreadState();
			applyStreamItem(state, snapshot({ thread: { id: 't1' }, runs: [done], ...projection }));
			return summarizeTask(state).status;
		};

		it('waits on awaited or delegated tasks of the active provider thread', () => {
			const provider = (tasks: unknown[], id = 'p1') => ({ id, pendingBackgroundTasks: tasks });
			expect(
				statusOf({
					thread: { id: 't1', activeProviderThreadId: 'p1' },
					providerThreads: [provider([{ taskId: 'x', kind: 'background_task' }])]
				})
			).toBe('waiting');
			expect(
				statusOf({ providerThreads: [provider([{ taskId: 'x', kind: 'command', awaited: true }])] })
			).toBe('waiting');
			// A plain command left running doesn't hold the thread.
			expect(statusOf({ providerThreads: [provider([{ taskId: 'x', kind: 'command' }])] })).toBe(
				'idle'
			);
			// Only the active provider thread counts.
			expect(
				statusOf({
					thread: { id: 't1', activeProviderThreadId: 'p2' },
					providerThreads: [provider([{ taskId: 'x', kind: 'subagent' }]), provider([], 'p2')]
				})
			).toBe('idle');
		});

		it('waits on a watched pull request until it merges', () => {
			const pr = (extra: Record<string, unknown> = {}) => ({
				host: 'github.com',
				repository: 'a/b',
				number: 1,
				watch: {},
				...extra
			});
			expect(statusOf({ thread: { id: 't1', pullRequests: [pr()] } })).toBe('waiting');
			expect(
				statusOf({ thread: { id: 't1', pullRequests: [pr({ snapshot: { state: 'merged' } })] } })
			).toBe('idle');
			expect(statusOf({ thread: { id: 't1', pullRequests: [pr({ watch: undefined })] } })).toBe(
				'idle'
			);
		});

		it('waits on a tool call still at work after its run ended', () => {
			const tool = (input: unknown) => ({
				id: 'i1',
				runId: 'run-1',
				ordinal: 1,
				type: 'dynamic_tool',
				status: 'running',
				input
			});
			expect(statusOf({ turnItems: [tool({})] })).toBe('waiting');
			expect(statusOf({ turnItems: [tool({ persistent: true })] })).toBe('idle');
		});

		it('picks up provider thread updates from the stream', () => {
			const state = emptyThreadState();
			applyStreamItem(state, snapshot({ thread: { id: 't1' }, runs: [done] }));
			expect(summarizeTask(state).status).toBe('idle');
			const update = event(11, 'provider-thread.updated', {
				id: 'p1',
				pendingBackgroundTasks: [{ taskId: 'x', kind: 'subagent' }]
			});
			expect(streamItemRun(update, state)).toBeNull();
			expect(applyStreamItem(state, update)).toBe(true);
			expect(summarizeTask(state).status).toBe('waiting');
		});

		it('is still running while a run is active', () => {
			expect(
				statusOf({
					runs: [run()],
					thread: { id: 't1', pullRequests: [{ host: 'h', repository: 'r', number: 1, watch: {} }] }
				})
			).toBe('running');
		});
	});

	it('stays running while a background subagent works after its run completed', () => {
		const state = emptyThreadState();
		const subagent = (status: string) => ({
			id: 's1',
			runId: 'run-1',
			ordinal: 1,
			type: 'subagent',
			status,
			startedAt: '2026-11-07T10:05:00.000Z'
		});
		applyStreamItem(
			state,
			snapshot({ runs: [run({ status: 'completed' })], turnItems: [subagent('running')] })
		);
		expect(summarizeTask(state)).toMatchObject({
			status: 'running',
			runStartedAt: Date.parse('2026-11-07T10:05:00.000Z')
		});
		applyStreamItem(
			state,
			snapshot({ runs: [run({ status: 'completed' })], turnItems: [subagent('completed')] }, 11)
		);
		expect(summarizeTask(state)).toMatchObject({ status: 'idle', runStartedAt: null });
	});

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
								options: [
									{ label: 'Postgres', description: 'Managed, scales out' },
									{ label: 'SQLite', value: 'sqlite' }
								]
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
				{ id: 'Postgres', label: 'Postgres', description: 'Managed, scales out' },
				{ id: 'sqlite', label: 'SQLite' }
			]
		});
	});

	it('ignores requests left pending by a run that has ended', () => {
		const state = emptyThreadState();
		const approval = (id: string, runId: string) => ({
			id: `item-${id}`,
			runId,
			ordinal: 1,
			type: 'approval_request',
			status: 'waiting',
			requestId: id,
			prompt: `Approve ${id}?`
		});
		applyStreamItem(
			state,
			snapshot({
				runs: [run({ status: 'interrupted' })],
				runtimeRequests: [{ id: 'stale', kind: 'command', status: 'pending' }],
				turnItems: [approval('stale', 'run-1')]
			})
		);
		expect(summarizeTask(state)).toMatchObject({ status: 'interrupted', pendingRequest: null });

		applyStreamItem(
			state,
			snapshot(
				{
					runs: [
						run({ status: 'interrupted' }),
						run({ id: 'run-2', ordinal: 2, status: 'waiting' })
					],
					runtimeRequests: [
						{ id: 'stale', kind: 'command', status: 'pending' },
						{ id: 'live', kind: 'command', status: 'pending', runId: 'run-2' }
					],
					turnItems: [approval('stale', 'run-1'), approval('live', 'run-2')]
				},
				11
			)
		);
		expect(summarizeTask(state)).toMatchObject({
			status: 'awaiting_input',
			pendingRequest: { requestId: 'live', title: 'Approve live?' }
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

describe('summarizeTask run timing', () => {
	it('reports when the active run started, falling back to when it was requested', () => {
		const state = emptyThreadState();
		applyStreamItem(
			state,
			snapshot({ runs: [run({ startedAt: '2026-11-07T10:00:05.000Z' })], thread: { id: 't1' } })
		);
		expect(summarizeTask(state).runStartedAt).toBe(Date.parse('2026-11-07T10:00:05.000Z'));

		const queued = emptyThreadState();
		applyStreamItem(queued, snapshot({ runs: [run()] }));
		expect(summarizeTask(queued).runStartedAt).toBe(Date.parse('2026-11-07T10:00:00.000Z'));
	});

	it('has no start time once the run is over', () => {
		const state = emptyThreadState();
		applyStreamItem(
			state,
			snapshot({ runs: [run({ status: 'completed' })], thread: { worktreePath: '/w/a' } })
		);
		expect(summarizeTask(state)).toMatchObject({ runStartedAt: null, worktreePath: '/w/a' });
	});
});

describe('size limits', () => {
	const item = (n: number, overrides: Record<string, unknown> = {}) => ({
		id: `i${n}`,
		runId: 'run-1',
		ordinal: n,
		type: 'assistant_message',
		status: 'completed',
		text: `step ${n}`,
		...overrides
	});

	it('truncates huge text and tool output per part', () => {
		const state = emptyThreadState();
		const huge = 'x'.repeat(MAX_PART_CHARS + 10);
		applyStreamItem(
			state,
			snapshot({
				runs: [run()],
				turnItems: [
					item(1, { text: huge }),
					item(2, { type: 'command_execution', input: 'ls', output: huge }),
					item(3, { type: 'dynamic_tool', toolName: 'Read', output: { data: [huge + huge] } })
				]
			})
		);
		const [text, command, tool] = renderRun(state, run()).map((e) => e.part);
		expect(text).toMatchObject({ text: 'x'.repeat(MAX_PART_CHARS) + TRUNCATED_MARKER });
		expect(command).toMatchObject({
			output: { output: 'x'.repeat(MAX_PART_CHARS) + TRUNCATED_MARKER }
		});
		expect(tool).toMatchObject({ output: { truncated: true } });
		expect(JSON.stringify(tool).length).toBeLessThan(MAX_PART_CHARS + 1000);
	});

	it('keeps only the latest parts of a run, behind a notice', () => {
		const state = emptyThreadState();
		const count = MAX_RUN_PARTS + 50;
		applyStreamItem(
			state,
			snapshot({ runs: [run()], turnItems: Array.from({ length: count }, (_, i) => item(i)) })
		);
		const entries = renderRun(state, run());
		expect(entries).toHaveLength(MAX_RUN_PARTS + 1);
		expect(entries[0].part).toMatchObject({ type: 'text', text: OMITTED_PARTS_NOTICE });
		expect(entries.at(-1)?.key).toBe(`i${count - 1}`);
	});

	it('caps the total size of a run', () => {
		const state = emptyThreadState();
		const big = 'y'.repeat(MAX_PART_CHARS);
		applyStreamItem(
			state,
			snapshot({
				runs: [run()],
				turnItems: Array.from({ length: 20 }, (_, i) => item(i, { text: big }))
			})
		);
		const entries = renderRun(state, run());
		expect(entries.length).toBeLessThan(20);
		expect(entries[0].part).toMatchObject({ text: OMITTED_PARTS_NOTICE });
		expect(JSON.stringify(entries.map((e) => e.part)).length).toBeLessThan(2.1 * 1024 * 1024);
	});

	it('drops the oldest records beyond the per-thread cap', () => {
		const state = emptyThreadState();
		applyStreamItem(state, snapshot({ runs: [run()], turnItems: [] }));
		for (let i = 0; i < MAX_THREAD_RECORDS + 10; i++) {
			applyStreamItem(state, event(100 + i, 'turn-item.updated', item(i)));
		}
		expect(state.turnItems.size).toBe(MAX_THREAD_RECORDS);
		expect(state.turnItems.has('i0')).toBe(false);
		expect(state.turnItems.has(`i${MAX_THREAD_RECORDS + 9}`)).toBe(true);
	});

	it('remembers which runs lost turn items to the cap', () => {
		const state = emptyThreadState();
		const items = [
			item(0, { runId: 'old' }),
			...Array.from({ length: MAX_THREAD_RECORDS }, (_, i) => item(i + 1))
		];
		applyStreamItem(state, snapshot({ runs: [run(), run({ id: 'old' })], turnItems: items }));
		expect(runItemsEvicted(state, 'old')).toBe(true);
		expect(runItemsEvicted(state, 'run-1')).toBe(false);

		applyStreamItem(state, event(11, 'turn-item.updated', item(MAX_THREAD_RECORDS + 1)));
		expect(runItemsEvicted(state, 'run-1')).toBe(true);

		// A later snapshot that fits starts over.
		applyStreamItem(state, snapshot({ runs: [run()], turnItems: [item(1)] }, 20));
		expect(runItemsEvicted(state, 'old')).toBe(false);
		expect(runItemsEvicted(state, 'run-1')).toBe(false);
	});
});

describe('hasRunningSubagent', () => {
	it('is true only while a subagent item is unfinished, even after its run ended', () => {
		const state = emptyThreadState();
		const item = (status: string) => ({
			id: 's1',
			runId: 'run-1',
			ordinal: 1,
			type: 'subagent',
			status
		});
		applyStreamItem(
			state,
			snapshot({ runs: [run({ status: 'completed' })], turnItems: [item('running')] })
		);
		expect(hasRunningSubagent(state)).toBe(true);
		applyStreamItem(
			state,
			snapshot({ runs: [run({ status: 'completed' })], turnItems: [item('completed')] }, 11)
		);
		expect(hasRunningSubagent(state)).toBe(false);
	});
});

describe('stored outputs', () => {
	const state = emptyThreadState();
	applyStreamItem(
		state,
		snapshot({
			runs: [run({ status: 'completed' })],
			turnItems: [
				{
					id: 'c1',
					runId: 'run-1',
					ordinal: 1,
					type: 'command_execution',
					status: 'completed',
					input: 'ls',
					exitCode: 0,
					outputOmitted: true
				},
				{
					id: 'd1',
					runId: 'run-1',
					ordinal: 2,
					type: 'dynamic_tool',
					status: 'completed',
					toolName: 'Read',
					outputOmitted: true
				},
				{
					id: 'c2',
					runId: 'run-1',
					ordinal: 3,
					type: 'command_execution',
					status: 'completed',
					input: 'pwd',
					outputOmitted: true
				}
			]
		})
	);
	const render = (outputs: Map<string, string> = new Map()) =>
		renderRun(state, state.runs.get('run-1')!, outputs);

	it('tells when omitted output is not loaded', () => {
		expect(hasUnloadedOutput(render())).toBe(true);
		expect(
			hasUnloadedOutput(
				render(
					new Map([
						['c1', 'a'],
						['d1', 'b'],
						['c2', 'c']
					])
				)
			)
		).toBe(false);
	});

	it('takes the outputs a stored reply holds, and renders the same parts with them', () => {
		const fetched = new Map([
			['c1', 'file.txt'],
			['d1', 'contents']
		]);
		const storedParts = JSON.parse(JSON.stringify(render(fetched).map((e) => e.part)));
		const found = storedOutputs(render(), storedParts);
		// c2 was never loaded: its stored placeholder isn't taken for an output.
		expect(found).toEqual(fetched);
		expect(render(found).map((e) => e.part)).toEqual(storedParts);
	});

	it('finds nothing in a reply without parts', () => {
		expect(storedOutputs(render(), null).size).toBe(0);
		expect(storedOutputs(render(), []).size).toBe(0);
	});
});
