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

// Limits on what a (possibly hostile or broken) T3 server can make Chatty
// hold and persist for one thread.
/** Records kept per kind (runs, messages, turn items, requests); the oldest are dropped. */
export const MAX_THREAD_RECORDS = 5000;
/** Characters kept of one part's text, or of one tool input/output (as JSON). */
export const MAX_PART_CHARS = 256 * 1024;
/** Parts rendered per run; earlier ones are replaced by a notice. */
export const MAX_RUN_PARTS = 300;
/** Characters (as JSON) rendered per run; earlier parts are replaced by a notice. */
export const MAX_RUN_CHARS = 2 * 1024 * 1024;
export const TRUNCATED_MARKER = '\n… (truncated)';
export const OMITTED_PARTS_NOTICE = '_Earlier steps of this run are not shown._';

/** Inserts or replaces `id` and drops the oldest records beyond the cap. */
function put(map: Map<string, Rec>, id: string, record: Rec): void {
	map.delete(id); // re-inserting moves it to the newest end
	map.set(id, record);
	while (map.size > MAX_THREAD_RECORDS) map.delete(map.keys().next().value!);
}

function fill(map: Map<string, Rec>, list: unknown): void {
	map.clear();
	if (!Array.isArray(list)) return;
	for (const entry of list.slice(-MAX_THREAD_RECORDS)) upsert(map, entry);
}

function upsert(map: Map<string, Rec>, payload: unknown): void {
	const record = obj(payload);
	const id = str(record?.id);
	if (record && id) put(map, id, record);
}

export function capText(text: string): string {
	return text.length > MAX_PART_CHARS ? text.slice(0, MAX_PART_CHARS) + TRUNCATED_MARKER : text;
}

/** Room for the other fields next to one capped string (e.g. `{ exitCode, output }`). */
const VALUE_SLACK_CHARS = 16 * 1024;

/**
 * Strings are cut to {@link MAX_PART_CHARS}. An object too large as JSON gets
 * its top-level strings cut; if it is still too large, it becomes a truncated
 * JSON preview.
 */
export function capValue(value: unknown): unknown {
	if (typeof value === 'string') return capText(value);
	if (!value || typeof value !== 'object') return value;
	if (JSON.stringify(value).length <= MAX_PART_CHARS) return value;
	if (!Array.isArray(value)) {
		const capped = Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, typeof v === 'string' ? capText(v) : v])
		);
		const json = JSON.stringify(capped);
		if (json.length <= MAX_PART_CHARS + VALUE_SLACK_CHARS) return capped;
		return { truncated: true, preview: capText(json) };
	}
	return { truncated: true, preview: capText(JSON.stringify(value)) };
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

/**
 * Which run's rendering a stream item can change: its id, `'all'` when that
 * isn't known (snapshots, messages, runtime requests), or null when no run's
 * parts depend on it (thread metadata). Lets callers re-render only that run.
 */
export function streamItemRun(item: unknown): string | 'all' | null {
	const it = obj(item);
	if (it?.kind !== 'event') return 'all';
	const event = obj(it.event);
	const type = str(event?.type) ?? '';
	const payload = obj(event?.payload);
	if (type.startsWith('thread.')) return null;
	if (type.startsWith('run.')) return str(payload?.id) ?? 'all';
	if (type.startsWith('turn-item.')) return str(payload?.runId) ?? 'all';
	return 'all';
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

/** Only http(s) links from the remote server are rendered as hrefs. */
function webUrl(value: string | null): string | null {
	if (!value) return null;
	try {
		const { protocol } = new URL(value);
		return protocol === 'https:' || protocol === 'http:' ? value : null;
	} catch {
		return null;
	}
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
	| {
			type: 'reasoning';
			text: string;
			state?: 'streaming' | 'done';
			/** When the step ran on the coding machine (ms), for "Thought for 12s". */
			providerMetadata?: { t3: { startedAt: number | null; completedAt: number | null } };
	  }
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
	input = capValue(input);
	output = capValue(output);
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
				errorText: capText(failureText(item) ?? 'Failed')
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
					part: { type: 'text', text: capText(text), state: streaming ? 'streaming' : 'done' }
				});
				break;
			}
			case 'reasoning': {
				const text = str(item.text) ?? '';
				if (!text) break;
				entries.push({
					key: id,
					final,
					part: {
						type: 'reasoning',
						text: capText(text),
						state: final ? 'done' : 'streaming',
						// Lets the timeline say "Thought for 12s" and time a live thought.
						providerMetadata: {
							t3: { startedAt: time(item.startedAt), completedAt: time(item.completedAt) }
						}
					}
				});
				break;
			}
			case 'proposed_plan': {
				const markdown = str(item.markdown);
				if (markdown) {
					entries.push({
						key: id,
						final,
						part: { type: 'text', text: capText(markdown), state: 'done' }
					});
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
						errorText: capText(
							failureText(item) ?? str(item.title) ?? 'The coding agent reported an error'
						)
					}
				});
				break;
			case 'dynamic_tool': {
				// The agent's own tools (Read, Grep, MCP tools…): keep the real name and
				// arguments so the timeline can say what happened.
				const toolName = str(item.toolName) ?? str(item.title) ?? 'tool';
				const fetched = commandOutputs.get(id);
				const output =
					item.output !== undefined
						? item.output
						: fetched !== undefined
							? fetched
							: item.outputOmitted === true
								? { note: 'Output not loaded' }
								: { status };
				entries.push(toolEntry(item, toolName, item.input ?? {}, output, status));
				break;
			}
			case 'subagent':
				entries.push(
					toolEntry(
						item,
						'subagent',
						{
							description: str(item.title) ?? str(item.prompt),
							prompt: str(item.prompt),
							// Kept on the input: a running step has no output yet, and this is
							// what the subagent is doing right now.
							progress: str(item.progress),
							provider: str(item.providerInstanceId) ?? str(item.driver),
							// Background subagents outlive the turn that started them; T3's own
							// status says whether this one is still at work.
							running: !DONE_ITEM.has(status)
						},
						str(item.result) ?? { status },
						status
					)
				);
				break;
			case 'checkpoint': {
				const files = Array.isArray(item.files) ? item.files.map(obj) : [];
				entries.push(
					toolEntry(
						item,
						'checkpoint',
						{ files: files.map((f) => str(f?.path)).filter((p): p is string => p !== null) },
						{
							additions: files.reduce((n, f) => n + (num(f?.additions) ?? 0), 0),
							deletions: files.reduce((n, f) => n + (num(f?.deletions) ?? 0), 0)
						},
						status
					)
				);
				break;
			}
			default:
				if (type) {
					entries.push(
						toolEntry(item, str(item.title) ?? type, { kind: type }, { status }, status)
					);
				}
		}
	}
	return limitRunEntries(String(run.id), entries);
}

/**
 * Keeps the latest parts of a run within {@link MAX_RUN_PARTS} and
 * {@link MAX_RUN_CHARS}, with a notice in place of the earlier ones.
 */
function limitRunEntries(runId: string, entries: RenderedEntry[]): RenderedEntry[] {
	let start = entries.length;
	let chars = 0;
	while (start > 0 && entries.length - start < MAX_RUN_PARTS) {
		chars += JSON.stringify(entries[start - 1].part).length;
		if (chars > MAX_RUN_CHARS) break;
		start--;
	}
	if (start === 0) return entries;
	return [
		{
			key: `${runId}:omitted`,
			final: true,
			part: { type: 'text', text: OMITTED_PARTS_NOTICE, state: 'done' }
		},
		...entries.slice(start)
	];
}

// ── task-level state ─────────────────────────────────────────────────────

export interface TaskSummary {
	status: CodingTaskStatus;
	branch: string | null;
	prUrl: string | null;
	title: string | null;
	pendingRequest: CodingPendingRequest | null;
	/** Start of the run in progress (ms), null when none is active. */
	runStartedAt: number | null;
	/** Worktree the thread works in; null means the project checkout. */
	worktreePath: string | null;
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
					.map((o) => {
						const description = str(o.description);
						return {
							id: str(o.value) ?? String(o.label),
							label: String(o.label),
							...(description ? { description } : {})
						};
					}),
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
	const prUrl = webUrl(
		str(linked?.url) ?? prs.map((p) => str(p?.url)).find((u) => u !== null) ?? null
	);
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
		pendingRequest: pending,
		runStartedAt: (() => {
			const run = activeRun(state);
			return run ? (time(run.startedAt) ?? time(run.requestedAt)) : null;
		})(),
		worktreePath: str(thread.worktreePath)
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
