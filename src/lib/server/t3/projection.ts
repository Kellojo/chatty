// Pure translation of a T3 Code thread (snapshot + events from
// `orchestration.subscribeThread`) into what Chatty shows: one assistant
// message per agent run (text, reasoning and tool parts), the task status,
// branch/PR, and the approval or question currently waiting on the user.
//
// T3 events carry the whole updated record (not a delta), so state is a set of
// maps upserted by id. Everything is decoded defensively; unknown event types
// and item kinds are ignored.

import type {
	CodingPendingOption,
	CodingPendingRequest,
	CodingTaskStatus
} from '$lib/coding-environments.js';

type Rec = Record<string, unknown>;

export interface ThreadState {
	thread: Rec | null;
	runs: Map<string, Rec>;
	messages: Map<string, Rec>;
	turnItems: Map<string, Rec>;
	runtimeRequests: Map<string, Rec>;
	lastSequence: number | null;
}

export function emptyThreadState(): ThreadState {
	return {
		thread: null,
		runs: new Map(),
		messages: new Map(),
		turnItems: new Map(),
		runtimeRequests: new Map(),
		lastSequence: null
	};
}

function obj(value: unknown): Rec | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function time(value: unknown): number | null {
	const s = str(value);
	if (!s) return null;
	const ms = Date.parse(s);
	return Number.isNaN(ms) ? null : ms;
}

function fill(map: Map<string, Rec>, list: unknown): void {
	map.clear();
	if (!Array.isArray(list)) return;
	for (const entry of list) {
		const record = obj(entry);
		const id = str(record?.id);
		if (record && id) map.set(id, record);
	}
}

function upsert(map: Map<string, Rec>, payload: unknown): void {
	const record = obj(payload);
	const id = str(record?.id);
	if (record && id) map.set(id, record);
}

/** Applies one `ThreadStreamItem` (snapshot or event). Returns true if state changed. */
export function applyStreamItem(state: ThreadState, item: unknown): boolean {
	const it = obj(item);
	if (!it) return false;
	if (it.kind === 'snapshot') {
		const projection = obj(it.projection) ?? {};
		state.thread = obj(projection.thread);
		fill(state.runs, projection.runs);
		fill(state.messages, projection.messages);
		fill(state.turnItems, projection.turnItems);
		fill(state.runtimeRequests, projection.runtimeRequests);
		state.lastSequence = num(it.snapshotSequence) ?? state.lastSequence;
		return true;
	}
	if (it.kind !== 'event') return false;
	const sequence = num(it.sequence);
	if (sequence !== null) state.lastSequence = sequence;
	const event = obj(it.event);
	const type = str(event?.type);
	if (!event || !type) return false;
	const payload = event.payload;
	if (type.startsWith('run.')) upsert(state.runs, payload);
	else if (type.startsWith('message.')) upsert(state.messages, payload);
	else if (type.startsWith('turn-item.')) upsert(state.turnItems, payload);
	else if (type.startsWith('runtime-request.')) upsert(state.runtimeRequests, payload);
	else if (type.startsWith('thread.')) {
		const record = obj(payload);
		// Most thread.* events carry the full thread; others (e.g. PR link
		// updates) carry a fragment, so merge rather than replace.
		if (record) state.thread = { ...(state.thread ?? {}), ...record };
	} else return false;
	return true;
}

// ── runs ─────────────────────────────────────────────────────────────────

const ACTIVE_RUN = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
const FINISHED_RUN = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);

export function isRunActive(run: Rec): boolean {
	return ACTIVE_RUN.has(String(run.status));
}

export function isRunFinished(run: Rec): boolean {
	return FINISHED_RUN.has(String(run.status));
}

export function sortedRuns(state: ThreadState): Rec[] {
	return [...state.runs.values()].sort((a, b) => (num(a.ordinal) ?? 0) - (num(b.ordinal) ?? 0));
}

export function activeRun(state: ThreadState): Rec | null {
	const runs = sortedRuns(state).filter(isRunActive);
	return runs.at(-1) ?? null;
}

/**
 * Chatty message id for a run's reply. Derived from the user message that
 * started the run (Chatty sends its own message ids to T3), so the mapping
 * survives restarts without extra bookkeeping.
 */
export function replyMessageId(run: Rec): string {
	const userMessageId = str(run.userMessageId);
	return userMessageId ? `${userMessageId}:reply` : `t3run:${String(run.id)}`;
}

// ── rendering ────────────────────────────────────────────────────────────

/** A UIMessage part as persisted in Chatty's `messages.parts`. */
export type RenderedPart =
	| { type: 'text'; text: string; state?: 'streaming' | 'done' }
	| { type: 'reasoning'; text: string; state?: 'streaming' | 'done' }
	| {
			type: 'dynamic-tool';
			toolName: string;
			toolCallId: string;
			state: 'input-available' | 'output-available' | 'output-error';
			input: unknown;
			output?: unknown;
			errorText?: string;
	  };

/** Stable identity + content of one rendered part, used to diff live updates. */
export interface RenderedEntry {
	key: string;
	part: RenderedPart;
	/** True once the item can no longer change (completed / failed / cancelled). */
	final: boolean;
}

const DONE_ITEM = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const BASE_ITEM_FIELDS = new Set([
	'id',
	'runId',
	'ordinal',
	'status',
	'type',
	'startedAt',
	'completedAt'
]);

function itemsForRun(state: ThreadState, runId: string): Rec[] {
	return [...state.turnItems.values()]
		.filter((item) => item.runId === runId)
		.sort((a, b) => (num(a.ordinal) ?? 0) - (num(b.ordinal) ?? 0));
}

function toolEntry(
	item: Rec,
	toolName: string,
	input: unknown,
	output: unknown,
	itemStatus: string
): RenderedEntry {
	const id = String(item.id);
	const final = DONE_ITEM.has(itemStatus);
	if (itemStatus === 'failed') {
		return {
			key: id,
			final,
			part: {
				type: 'dynamic-tool',
				toolName,
				toolCallId: id,
				state: 'output-error',
				input,
				errorText: failureText(item) ?? 'Failed'
			}
		};
	}
	return {
		key: id,
		final,
		part: final
			? { type: 'dynamic-tool', toolName, toolCallId: id, state: 'output-available', input, output }
			: { type: 'dynamic-tool', toolName, toolCallId: id, state: 'input-available', input }
	};
}

function failureText(item: Rec): string | null {
	const failure = item.failure;
	if (typeof failure === 'string') return failure;
	const f = obj(failure);
	return str(f?.message) ?? str(f?.detail) ?? null;
}

function requestDecision(state: ThreadState, requestId: unknown): string | null {
	const request = state.runtimeRequests.get(String(requestId));
	if (!request) return null;
	return str(request.decision) ?? (request.status === 'pending' ? null : String(request.status));
}

/** Command output fetched separately (the live stream omits it). */
export type CommandOutputs = ReadonlyMap<string, string>;

/** Renders one run's turn items as ordered message parts. */
export function renderRun(
	state: ThreadState,
	run: Rec,
	commandOutputs: CommandOutputs = new Map()
): RenderedEntry[] {
	const entries: RenderedEntry[] = [];
	for (const item of itemsForRun(state, String(run.id))) {
		const id = String(item.id);
		const type = str(item.type) ?? '';
		const status = str(item.status) ?? 'running';
		const final = DONE_ITEM.has(status);
		switch (type) {
			case 'user_message':
			case 'system_notice':
				break;
			case 'assistant_message': {
				const text = str(item.text) ?? '';
				if (!text) break;
				const streaming = item.streaming === true && !final;
				entries.push({
					key: id,
					final: !streaming,
					part: { type: 'text', text, state: streaming ? 'streaming' : 'done' }
				});
				break;
			}
			case 'reasoning': {
				const text = str(item.text) ?? '';
				if (!text) break;
				entries.push({
					key: id,
					final,
					part: { type: 'reasoning', text, state: final ? 'done' : 'streaming' }
				});
				break;
			}
			case 'proposed_plan': {
				const markdown = str(item.markdown);
				if (markdown) {
					entries.push({ key: id, final, part: { type: 'text', text: markdown, state: 'done' } });
				}
				break;
			}
			case 'command_execution': {
				const exitCode = num(item.exitCode);
				const output = commandOutputs.get(id) ?? str(item.output);
				entries.push(
					toolEntry(
						item,
						'run_command',
						{ command: item.input ?? item.title ?? '' },
						{
							exitCode,
							...(output !== null ? { output } : { note: 'Output not loaded' })
						},
						status === 'completed' && item.outputIndicatesFailure === true ? 'failed' : status
					)
				);
				break;
			}
			case 'file_change': {
				const changes = Array.isArray(item.changes) ? item.changes : [];
				const files = changes.map((c) => str(obj(c)?.path)).filter((p): p is string => p !== null);
				entries.push(
					toolEntry(
						item,
						'edit_files',
						{ files: files.length > 0 ? files : [str(item.fileName) ?? 'file'] },
						{ additions: num(item.additions), deletions: num(item.deletions) },
						status
					)
				);
				break;
			}
			case 'web_search':
			case 'file_search': {
				const input = Object.fromEntries(
					Object.entries(item).filter(([k]) => !BASE_ITEM_FIELDS.has(k))
				);
				entries.push(toolEntry(item, type, input, { done: true }, status));
				break;
			}
			case 'todo_list':
				entries.push(
					toolEntry(item, 'todo_list', { steps: item.steps ?? [] }, { ok: true }, status)
				);
				break;
			case 'approval_request':
				entries.push(
					toolEntry(
						item,
						'approval',
						{ request: item.prompt ?? item.title ?? item.requestKind, reason: item.reason },
						{ decision: requestDecision(state, item.requestId) },
						requestDecision(state, item.requestId) ? 'completed' : 'running'
					)
				);
				break;
			case 'user_input_request':
				entries.push(
					toolEntry(
						item,
						'question',
						{ questions: item.questions ?? [] },
						{ status: requestDecision(state, item.requestId) },
						requestDecision(state, item.requestId) ? 'completed' : 'running'
					)
				);
				break;
			case 'error':
				entries.push({
					key: id,
					final: true,
					part: {
						type: 'dynamic-tool',
						toolName: 'error',
						toolCallId: id,
						state: 'output-error',
						input: {},
						errorText: failureText(item) ?? str(item.title) ?? 'The coding agent reported an error'
					}
				});
				break;
			default:
				if (type) {
					entries.push(
						toolEntry(item, str(item.title) ?? type, { kind: type }, { status }, status)
					);
				}
		}
	}
	return entries;
}

// ── task-level state ─────────────────────────────────────────────────────

export interface TaskSummary {
	status: CodingTaskStatus;
	branch: string | null;
	prUrl: string | null;
	title: string | null;
	pendingRequest: CodingPendingRequest | null;
}

const DEFAULT_DECISIONS: CodingPendingOption[] = [
	{ id: 'accept', label: 'Approve' },
	{ id: 'decline', label: 'Decline' }
];

function pendingRequest(state: ThreadState): CodingPendingRequest | null {
	const pending = [...state.runtimeRequests.values()].filter((r) => r.status === 'pending');
	for (const request of pending) {
		const requestId = String(request.id);
		const item = [...state.turnItems.values()].find((i) => i.requestId === requestId);
		const createdAt = time(request.createdAt) ?? time(item?.startedAt) ?? Date.now();
		if (request.kind === 'user_input' || item?.type === 'user_input_request') {
			const questions = Array.isArray(item?.questions) ? item.questions.map(obj) : [];
			const question = questions.find((q) => q !== null) ?? null;
			const options = Array.isArray(question?.options) ? question.options : [];
			return {
				requestId,
				kind: 'question',
				questionId: str(question?.id) ?? undefined,
				title: str(question?.question) ?? str(question?.header) ?? 'The agent has a question',
				detail: str(question?.header) && str(question?.question) ? str(question?.header) : null,
				options: options
					.map(obj)
					.filter((o): o is Rec => o !== null && str(o.label) !== null)
					.map((o) => ({ id: str(o.value) ?? String(o.label), label: String(o.label) })),
				allowFreeText: question?.allowCustomAnswer !== false || options.length === 0,
				createdAt
			};
		}
		const options = Array.isArray(item?.options)
			? item.options
					.map(obj)
					.filter((o): o is Rec => o !== null && str(o.decision) !== null)
					.map((o) => ({ id: String(o.decision), label: str(o.label) ?? String(o.decision) }))
			: [];
		return {
			requestId,
			kind: 'approval',
			title:
				str(item?.prompt) ??
				str(item?.title) ??
				`Approve ${str(request.kind)?.replace(/[-_]/g, ' ') ?? 'action'}?`,
			detail: str(item?.reason),
			options: options.length > 0 ? options : DEFAULT_DECISIONS,
			allowFreeText: true,
			createdAt
		};
	}
	return null;
}

export function summarizeTask(state: ThreadState): TaskSummary {
	const thread = state.thread ?? {};
	const linked = obj(thread.linkedPullRequest);
	const prs = Array.isArray(thread.pullRequests) ? thread.pullRequests.map(obj) : [];
	const prUrl = str(linked?.url) ?? prs.map((p) => str(p?.url)).find((u) => u !== null) ?? null;
	const pending = pendingRequest(state);
	const runs = sortedRuns(state);
	const last = runs.at(-1);
	let status: CodingTaskStatus;
	if (pending) status = 'awaiting_input';
	else if (runs.some(isRunActive)) status = 'running';
	else if (!last) status = 'starting';
	else if (last.status === 'completed') status = 'idle';
	else if (last.status === 'failed') status = 'failed';
	else status = 'interrupted';
	return {
		status,
		branch: str(thread.branch),
		prUrl,
		title: str(thread.title),
		pendingRequest: pending
	};
}

/** Text of a T3 message (used to mirror user messages sent from T3 itself). */
export function messageText(state: ThreadState, messageId: string): string | null {
	return str(state.messages.get(messageId)?.text);
}

export function runFailureText(state: ThreadState, run: Rec): string | null {
	if (run.status === 'failed') {
		const items = itemsForRun(state, String(run.id)).filter((i) => i.type === 'error');
		return failureText(items.at(-1) ?? {}) ?? 'The coding agent run failed';
	}
	if (run.status === 'interrupted' || run.status === 'cancelled') return 'Interrupted';
	return null;
}
