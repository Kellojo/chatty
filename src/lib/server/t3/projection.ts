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
	CodingPullRequestState,
	CodingTaskStatus
} from '$lib/coding-environments.js';

type Rec = Record<string, unknown>;

export interface ThreadState {
	thread: Rec | null;
	runs: Map<string, Rec>;
	messages: Map<string, Rec>;
	turnItems: Map<string, Rec>;
	runtimeRequests: Map<string, Rec>;
	/** The provider sessions behind the thread; they list background work the agent waits on. */
	providerThreads: Map<string, Rec>;
	/** Runs some of whose turn items were dropped by {@link MAX_THREAD_RECORDS}. */
	evictedItemRuns: Set<string>;
	lastSequence: number | null;
	// Indexes over `turnItems`, kept in step by applyStreamItem (rendering a run
	// or finding a request's item must not scan a long thread's every item).
	/** Turn items by run id, then item id. */
	itemsByRun: Map<string, Map<string, Rec>>;
	/** Turn items by type, then item id. */
	itemsByType: Map<string, Map<string, Rec>>;
	/** The turn item showing each runtime request, by request id. */
	itemByRequest: Map<string, Rec>;
}

export function emptyThreadState(): ThreadState {
	return {
		thread: null,
		runs: new Map(),
		messages: new Map(),
		turnItems: new Map(),
		runtimeRequests: new Map(),
		providerThreads: new Map(),
		evictedItemRuns: new Set(),
		lastSequence: null,
		itemsByRun: new Map(),
		itemsByType: new Map(),
		itemByRequest: new Map()
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

type OnEvict = (record: Rec) => void;

/** Inserts or replaces `id` and drops the oldest records beyond the cap. */
function put(map: Map<string, Rec>, id: string, record: Rec, onEvict?: OnEvict): void {
	map.delete(id); // re-inserting moves it to the newest end
	map.set(id, record);
	while (map.size > MAX_THREAD_RECORDS) {
		const oldest = map.keys().next().value!;
		const evicted = map.get(oldest);
		map.delete(oldest);
		if (evicted) onEvict?.(evicted);
	}
}

function fill(map: Map<string, Rec>, list: unknown, onEvict?: OnEvict): void {
	map.clear();
	if (!Array.isArray(list)) return;
	for (const entry of list) upsert(map, entry, onEvict);
}

function upsert(map: Map<string, Rec>, payload: unknown, onEvict?: OnEvict): void {
	const record = obj(payload);
	const id = str(record?.id);
	if (record && id) put(map, id, record, onEvict);
}

function indexAdd(index: Map<string, Map<string, Rec>>, key: string | null, id: string, item: Rec) {
	if (!key) return;
	let bucket = index.get(key);
	if (!bucket) index.set(key, (bucket = new Map()));
	bucket.set(id, item);
}

function indexRemove(index: Map<string, Map<string, Rec>>, key: string | null, id: string) {
	const bucket = key ? index.get(key) : undefined;
	if (!bucket) return;
	bucket.delete(id);
	if (bucket.size === 0) index.delete(key!);
}

function unindexItem(state: ThreadState, item: Rec): void {
	const id = String(item.id);
	indexRemove(state.itemsByRun, str(item.runId), id);
	indexRemove(state.itemsByType, str(item.type), id);
	const requestId = str(item.requestId);
	if (requestId && state.itemByRequest.get(requestId) === item) {
		state.itemByRequest.delete(requestId);
	}
}

/** Upserts a turn item and keeps the indexes in step. */
function putItem(state: ThreadState, payload: unknown): void {
	const item = obj(payload);
	const id = str(item?.id);
	if (!item || !id) return;
	const previous = state.turnItems.get(id);
	if (previous) unindexItem(state, previous);
	put(state.turnItems, id, item, (evicted) => {
		unindexItem(state, evicted);
		// Remembers whose items were dropped, so their history isn't re-rendered from a partial set.
		const runId = str(evicted.runId);
		if (runId) state.evictedItemRuns.add(runId);
	});
	indexAdd(state.itemsByRun, str(item.runId), id, item);
	indexAdd(state.itemsByType, str(item.type), id, item);
	const requestId = str(item.requestId);
	if (requestId) state.itemByRequest.set(requestId, item);
}

function fillItems(state: ThreadState, list: unknown): void {
	state.turnItems.clear();
	state.itemsByRun.clear();
	state.itemsByType.clear();
	state.itemByRequest.clear();
	if (!Array.isArray(list)) return;
	for (const entry of list) putItem(state, entry);
}

/** A run's turn items, unordered. */
export function runItems(state: ThreadState, runId: string): Rec[] {
	return [...(state.itemsByRun.get(runId)?.values() ?? [])];
}

/** The thread's turn items of one type, unordered. */
export function itemsOfType(state: ThreadState, type: string): Rec[] {
	return [...(state.itemsByType.get(type)?.values() ?? [])];
}

/**
 * Whether some of this run's turn items were dropped by the per-thread cap.
 * Rendering such a run yields only part of its history, so a finished run's
 * persisted reply should be kept rather than overwritten with it.
 */
export function runItemsEvicted(state: ThreadState, runId: string): boolean {
	return state.evictedItemRuns.has(runId);
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
		// A snapshot replaces everything, so a malformed one must not wipe state.
		const projection = obj(it.projection);
		if (!projection) return false;
		state.thread = obj(projection.thread);
		fill(state.runs, projection.runs);
		fill(state.messages, projection.messages);
		state.evictedItemRuns.clear();
		fillItems(state, projection.turnItems);
		fill(state.runtimeRequests, projection.runtimeRequests);
		fill(state.providerThreads, projection.providerThreads);
		state.lastSequence = num(it.snapshotSequence) ?? state.lastSequence;
		return true;
	}
	if (it.kind !== 'event') return false;
	const sequence = num(it.sequence);
	if (sequence !== null) {
		// Already reflected (e.g. replayed after a snapshot): applying it could regress records.
		if (state.lastSequence !== null && sequence <= state.lastSequence) return false;
		state.lastSequence = sequence;
	}
	const event = obj(it.event);
	const type = str(event?.type);
	if (!event || !type) return false;
	const payload = event.payload;
	if (type.startsWith('run.')) upsert(state.runs, payload);
	else if (type.startsWith('message.')) upsert(state.messages, payload);
	else if (type.startsWith('turn-item.')) putItem(state, payload);
	else if (type.startsWith('runtime-request.')) upsert(state.runtimeRequests, payload);
	else if (type.startsWith('provider-thread.')) upsert(state.providerThreads, payload);
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
 * isn't known (snapshots), or null when no run's parts depend on it (thread
 * metadata). Lets callers re-render only that run.
 *
 * Pass `state` (with the item already applied) to route messages and runtime
 * requests that don't name their run: a message shows in the run it started,
 * a request in the run of the turn item showing it.
 */
export function streamItemRun(item: unknown, state?: ThreadState): string | 'all' | null {
	const it = obj(item);
	if (it?.kind !== 'event') return 'all';
	const event = obj(it.event);
	const type = str(event?.type) ?? '';
	const payload = obj(event?.payload);
	if (type.startsWith('thread.') || type.startsWith('provider-thread.')) return null;
	if (type.startsWith('run.')) return str(payload?.id) ?? 'all';
	if (type.startsWith('turn-item.')) return str(payload?.runId) ?? 'all';
	const id = str(payload?.id);
	if (type.startsWith('message.')) {
		const runId = str(payload?.runId);
		if (!state || !id) return runId ?? 'all';
		// Runs read their user message by `userMessageId`.
		for (const run of state.runs.values()) if (run.userMessageId === id) return String(run.id);
		// Otherwise no run shows it (yet); that run's own event will render it.
		return runId;
	}
	if (type.startsWith('runtime-request.')) {
		const item = id ? state?.itemByRequest.get(id) : undefined;
		const runId = str(item?.runId) ?? str(payload?.runId);
		if (runId) return runId;
		// Only turn items show a request; none does yet.
		return state && id ? null : 'all';
	}
	return 'all';
}

/** The record maps of a thread, copied before a snapshot replaces them (see {@link changedRuns}). */
export interface ThreadRecords {
	runs: ReadonlyMap<string, Rec>;
	messages: ReadonlyMap<string, Rec>;
	turnItems: ReadonlyMap<string, Rec>;
	runtimeRequests: ReadonlyMap<string, Rec>;
}

export function copyThreadRecords(state: ThreadState): ThreadRecords {
	return {
		runs: new Map(state.runs),
		messages: new Map(state.messages),
		turnItems: new Map(state.turnItems),
		runtimeRequests: new Map(state.runtimeRequests)
	};
}

/** Ids of records added, removed or changed between two maps. */
function changedIds(before: ReadonlyMap<string, Rec>, after: ReadonlyMap<string, Rec>): string[] {
	const ids: string[] = [];
	for (const [id, record] of after) {
		const old = before.get(id);
		if (old !== record && (!old || JSON.stringify(old) !== JSON.stringify(record))) ids.push(id);
	}
	for (const id of before.keys()) if (!after.has(id)) ids.push(id);
	return ids;
}

/**
 * Runs whose rendering may differ after a snapshot replaced `before` (a
 * resubscription mostly brings back the same thread), or `'all'` when a
 * change can't be pinned to a run.
 */
export function changedRuns(before: ThreadRecords, after: ThreadState): Set<string> | 'all' {
	const runs = new Set<string>();
	for (const id of changedIds(before.runs, after.runs)) runs.add(id);
	for (const id of changedIds(before.turnItems, after.turnItems)) {
		for (const item of [before.turnItems.get(id), after.turnItems.get(id)]) {
			const runId = str(item?.runId);
			if (item && !runId) return 'all';
			if (runId) runs.add(runId);
		}
	}
	const messageIds = new Set(changedIds(before.messages, after.messages));
	if (messageIds.size > 0) {
		for (const run of after.runs.values()) {
			if (messageIds.has(String(run.userMessageId))) runs.add(String(run.id));
		}
	}
	for (const id of changedIds(before.runtimeRequests, after.runtimeRequests)) {
		const item = after.itemByRequest.get(id);
		const request = after.runtimeRequests.get(id) ?? before.runtimeRequests.get(id);
		const runId = str(item?.runId) ?? str(request?.runId);
		if (runId) runs.add(runId);
		else if (item) return 'all';
	}
	return runs;
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

/**
 * The run that took up user message `messageId`: the run started for it, or,
 * when it was sent while another run was active, the run T3 added it to.
 */
export function runForUserMessage(state: ThreadState, messageId: string): Rec | null {
	for (const run of state.runs.values()) {
		if (run.userMessageId === messageId) return run;
	}
	for (const item of itemsOfType(state, 'user_message')) {
		if (str(item.messageId) !== messageId) continue;
		const run = state.runs.get(str(item.runId) ?? '');
		if (run) return run;
	}
	return null;
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
function runningSubagents(state: ThreadState): Rec[] {
	return itemsOfType(state, 'subagent').filter((item) => !DONE_ITEM.has(String(item.status)));
}

/** Whether a subagent in the thread is still at work (it can outlive its turn). */
export function hasRunningSubagent(state: ThreadState): boolean {
	return runningSubagents(state).length > 0;
}

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
	return runItems(state, runId).sort((a, b) => (num(a.ordinal) ?? 0) - (num(b.ordinal) ?? 0));
}

/** Final item statuses that aren't a success, with the text shown for them. */
const STOPPED_ITEM = new Map([
	['cancelled', 'Cancelled'],
	['interrupted', 'Interrupted']
]);

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
	const stopped = STOPPED_ITEM.get(itemStatus);
	if (itemStatus === 'failed' || stopped) {
		return {
			key: id,
			final,
			part: {
				type: 'dynamic-tool',
				toolName,
				toolCallId: id,
				state: 'output-error',
				input,
				errorText: capText(failureText(item) ?? stopped ?? 'Failed')
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

/** Shown for omitted output that hasn't been fetched (see {@link CommandOutputs}). */
const OUTPUT_NOT_LOADED = 'Output not loaded';

function isOutputNotLoaded(part: RenderedPart): boolean {
	return (
		part.type === 'dynamic-tool' &&
		part.state === 'output-available' &&
		obj(part.output)?.note === OUTPUT_NOT_LOADED
	);
}

/** Whether some tool part in `entries` shows omitted output that isn't loaded. */
export function hasUnloadedOutput(entries: readonly RenderedEntry[]): boolean {
	return entries.some((e) => isOutputNotLoaded(e.part));
}

/**
 * The outputs a stored reply already holds for the tool parts of `entries`
 * that render without theirs, by item id, in the form {@link CommandOutputs}
 * takes. Fetched outputs live only in memory, so a fresh follower would
 * otherwise render (and save) the placeholder over outputs fetched before.
 */
export function storedOutputs(
	entries: readonly RenderedEntry[],
	storedParts: unknown
): Map<string, string> {
	const found = new Map<string, string>();
	if (!Array.isArray(storedParts)) return found;
	const stored = new Map<string, Rec>();
	for (const part of storedParts) {
		const p = obj(part);
		if (p?.type === 'dynamic-tool' && p.state === 'output-available') {
			stored.set(String(p.toolCallId), p);
		}
	}
	for (const { part } of entries) {
		if (part.type !== 'dynamic-tool' || !isOutputNotLoaded(part)) continue;
		const output = stored.get(part.toolCallId)?.output;
		// A command's output sits beside its exit code; another tool's is the whole output.
		const text = 'exitCode' in obj(part.output)! ? str(obj(output)?.output) : str(output);
		if (text !== null) found.set(part.toolCallId, text);
	}
	return found;
}

/** What the user answered, per request id (Chatty keeps it; T3 only reports the outcome). */
export type RequestAnswers = Readonly<Record<string, string>>;

/** Renders one run's turn items as ordered message parts. */
export function renderRun(
	state: ThreadState,
	run: Rec,
	commandOutputs: CommandOutputs = new Map(),
	answers: RequestAnswers = {}
): RenderedEntry[] {
	return renderRunSegments(state, run, commandOutputs, answers).flatMap((s) => s.entries);
}

/**
 * The part of a run that answers one user message. A message sent while the
 * run was active is added to it (T3 steers the agent with it) rather than
 * starting a run of its own, so the agent's work after it answers that message.
 */
export interface RunSegment {
	/** The message this part answers: the run's own, or one added mid-run (null: none). */
	userMessageId: string | null;
	/** The added message's turn item; null for the run's first segment. */
	item: Rec | null;
	entries: RenderedEntry[];
}

/** Renders a run's turn items, split at each user message added to it mid-run. */
export function renderRunSegments(
	state: ThreadState,
	run: Rec,
	commandOutputs: CommandOutputs = new Map(),
	answers: RequestAnswers = {}
): RunSegment[] {
	const runId = String(run.id);
	const runUserMessageId = str(run.userMessageId);
	/** A resolved request's outcome, with the user's words when known. */
	const resolution = (requestId: unknown, key: 'decision' | 'status') => {
		const value = requestDecision(state, requestId);
		const answer = value ? answers[String(requestId)] : undefined;
		return { [key]: value, ...(answer ? { answer } : {}) };
	};
	const segments: RunSegment[] = [{ userMessageId: runUserMessageId, item: null, entries: [] }];
	let entries = segments[0].entries;
	for (const item of itemsForRun(state, runId)) {
		const id = String(item.id);
		const type = str(item.type) ?? '';
		const status = str(item.status) ?? 'running';
		const final = DONE_ITEM.has(status);
		switch (type) {
			case 'user_message': {
				const messageId = str(item.messageId);
				if (
					messageId &&
					messageId !== runUserMessageId &&
					!isAgentNotification(state, messageId) &&
					!segments.some((s) => s.userMessageId === messageId)
				) {
					const segment: RunSegment = { userMessageId: messageId, item, entries: [] };
					segments.push(segment);
					entries = segment.entries;
				}
				break;
			}
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
							...(output !== null ? { output } : { note: OUTPUT_NOT_LOADED })
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
						resolution(item.requestId, 'decision'),
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
						resolution(item.requestId, 'status'),
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
								? { note: OUTPUT_NOT_LOADED }
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
							running: !DONE_ITEM.has(status),
							// So the card can say how long it has been (or was) at work.
							startedAt: time(item.startedAt),
							completedAt: time(item.completedAt)
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
						{
							files: files.map((f) => str(f?.path)).filter((p): p is string => p !== null),
							// Per file, for the changed-files list when T3 can't serve line diffs.
							changes: files
								.filter((f) => str(f?.path) !== null)
								.map((f) => ({
									path: str(f?.path),
									kind: str(f?.kind),
									additions: num(f?.additions) ?? 0,
									deletions: num(f?.deletions) ?? 0
								}))
						},
						{
							additions: files.reduce((n, f) => n + (num(f?.additions) ?? 0), 0),
							deletions: files.reduce((n, f) => n + (num(f?.deletions) ?? 0), 0)
						},
						status
					)
				);
				break;
			}
			case 'notification': {
				// "Command … and subagent … were stopped": a one-off message, never in progress.
				const text = str(item.text) ?? str(item.title);
				if (!text) break;
				entries.push(
					toolEntry(item, 'notice', { text }, { ok: true }, final ? status : 'completed')
				);
				break;
			}
			default:
				if (type) {
					// Unknown item types still show what they say.
					const text = str(item.text);
					entries.push(
						toolEntry(
							item,
							str(item.title) ?? type,
							{ kind: type, ...(text ? { text } : {}) },
							{ status },
							status
						)
					);
				}
		}
	}
	return segments.map((segment, i) => ({
		...segment,
		entries: limitRunEntries(i === 0 ? runId : `${runId}:${i}`, segment.entries)
	}));
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
	prState: CodingPullRequestState | null;
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
	const itemFor = (request: Rec) => state.itemByRequest.get(String(request.id));
	const current = str(activeRun(state)?.id);
	// A request left pending by a run that has since ended can't be answered, so
	// only requests of a still-active run count, the latest run's first.
	const pending = [...state.runtimeRequests.values()]
		.filter((r) => r.status === 'pending')
		.map((request) => {
			const runId = str(request.runId) ?? str(itemFor(request)?.runId);
			const run = runId ? state.runs.get(runId) : undefined;
			return { request, runId, active: runId ? !!run && isRunActive(run) : current !== null };
		})
		.filter((p) => p.active)
		.sort((a, b) => Number(b.runId === current) - Number(a.runId === current))
		.map((p) => p.request);
	for (const request of pending) {
		const requestId = String(request.id);
		const item = itemFor(request);
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

/** A PR record's state: on the record itself or on T3's cached `snapshot` of it. */
function pullRequestState(record: Rec): CodingPullRequestState | null {
	const raw = record.snapshot;
	let snapshot = obj(raw);
	if (!snapshot && typeof raw === 'string') {
		try {
			snapshot = obj(JSON.parse(raw));
		} catch {
			snapshot = null;
		}
	}
	const source = snapshot ?? record;
	const state = str(source.state)?.toLowerCase();
	if (state === 'merged' || source.mergedAt) return 'merged';
	if (state === 'closed') return 'closed';
	if (state === 'open') return source.isDraft === true ? 'draft' : 'open';
	return null;
}

/**
 * The thread's pull request: the one linked to it, else one it opened, else
 * one T3 found for its branch (e.g. opened outside the agent), with the last
 * state T3 observed for it.
 */
function pullRequestOf(thread: Rec): { url: string | null; state: CodingPullRequestState | null } {
	const records = [
		obj(thread.linkedPullRequest),
		...(Array.isArray(thread.pullRequests) ? thread.pullRequests.map(obj) : []),
		obj(thread.branchPullRequest)
	].filter((r): r is Rec => r !== null && webUrl(str(r.url)) !== null);
	const url = records[0] ? str(records[0].url) : null;
	if (!url) return { url: null, state: null };
	// The linked record may be a bare reference while another carries the state.
	const same = records.filter((r) => str(r.url)?.toLowerCase() === url.toLowerCase());
	const state = same.map(pullRequestState).find((s) => s !== null) ?? null;
	return { url, state };
}

// ── background work ──────────────────────────────────────────────────────
// Mirrors T3's "Waiting" thread state: the latest run has ended, but the agent
// still waits on work it started (a background task, a delegated thread, a
// watched pull request) and resumes when that reports back.

/** Latest-run statuses after which T3 counts pending background work as waiting. */
const SETTLED_FOR_BACKGROUND_WAIT = new Set([
	'cancelled',
	'completed',
	'failed',
	'interrupted',
	'waiting'
]);
const ACTIVE_ITEM = new Set(['pending', 'running', 'waiting']);

/** Whether one of T3's pending background tasks keeps the thread waiting (plain commands don't). */
export function isAwaitedBackgroundTask(task: unknown): boolean {
	const t = obj(task);
	return !!t && (t.awaited === true || t.kind === 'subagent' || t.kind === 'background_task');
}

/** Pull requests T3 watches for the agent (each one keeps the thread waiting). */
function hasWatchedPullRequest(thread: Rec): boolean {
	const links = Array.isArray(thread.pullRequests) ? thread.pullRequests.map(obj) : [];
	return links.some(
		(link) =>
			link !== null &&
			link.watch !== undefined &&
			link.source !== 'stack-dismissed' &&
			obj(link.snapshot)?.state !== 'merged'
	);
}

function isWaitingOnBackgroundWork(state: ThreadState, latestRun: Rec | undefined): boolean {
	const thread = state.thread ?? {};
	if (!latestRun) return hasWatchedPullRequest(thread);
	if (!SETTLED_FOR_BACKGROUND_WAIT.has(String(latestRun.status))) return false;
	const activeProvider = str(thread.activeProviderThreadId);
	for (const provider of state.providerThreads.values()) {
		if (activeProvider && provider.id !== activeProvider) continue;
		const tasks = Array.isArray(provider.pendingBackgroundTasks)
			? provider.pendingBackgroundTasks
			: [];
		if (tasks.some(isAwaitedBackgroundTask)) return true;
	}
	// A tool call still at work after its run ended (unless persistent or rolled
	// back). Plain commands running on don't hold the thread; running subagents
	// already count as running.
	const waitingTool = itemsOfType(state, 'dynamic_tool').some(
		(item) =>
			ACTIVE_ITEM.has(String(item.status)) &&
			obj(item.input)?.persistent !== true &&
			state.runs.get(String(item.runId))?.status !== 'rolled_back'
	);
	return waitingTool || hasWatchedPullRequest(thread);
}

export function summarizeTask(state: ThreadState): TaskSummary {
	const thread = state.thread ?? {};
	const { url: prUrl, state: prState } = pullRequestOf(thread);
	const pending = pendingRequest(state);
	const runs = sortedRuns(state);
	const last = runs.at(-1);
	let status: CodingTaskStatus;
	if (pending) status = 'awaiting_input';
	// Background subagents keep working after their turn ends; the task isn't
	// done until they are.
	else if (runs.some(isRunActive) || hasRunningSubagent(state)) status = 'running';
	else if (isWaitingOnBackgroundWork(state, last)) status = 'waiting';
	else if (!last) status = 'starting';
	else if (last.status === 'completed') status = 'idle';
	else if (last.status === 'failed') status = 'failed';
	else status = 'interrupted';
	return {
		status,
		branch: str(thread.branch),
		prUrl,
		prState,
		title: str(thread.title),
		pendingRequest: pending,
		runStartedAt: (() => {
			const run = activeRun(state);
			if (run) return time(run.startedAt) ?? time(run.requestedAt);
			// Only subagents left: time from when the earliest of them started.
			const starts = runningSubagents(state)
				.map((item) => time(item.startedAt))
				.filter((t): t is number => t !== null);
			return starts.length > 0 ? Math.min(...starts) : null;
		})(),
		worktreePath: str(thread.worktreePath)
	};
}

/**
 * Whether a T3 "user" message was really written by the agent's runtime: the
 * notices that wake the agent when a background task or subagent finishes
 * ("This agent's report was delivered to you…", "Background task completed.").
 */
export function isAgentNotification(state: ThreadState, messageId: string): boolean {
	const message = state.messages.get(messageId);
	return !!message && (message.notification != null || message.createdBy === 'agent');
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
