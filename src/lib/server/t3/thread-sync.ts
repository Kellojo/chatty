// Periodic pass over each connected environment's thread list (T3's shell
// snapshot), every THREAD_SYNC_INTERVAL_MS:
// - imports threads started on the T3 server itself as coding conversations,
//   so they show up in Chatty like tasks started here;
// - follows tasks whose thread is running on T3 (e.g. a message sent from T3)
//   and loads the change size of tasks that don't have one yet;
// - reconciles every coding task's title, pinned, settled and read state
//   (see ./thread-state.ts).
// Between passes, a live shell subscription per environment reconciles a task
// as soon as its thread changes on T3 (see ShellWatcher below).

import type { CodingTaskStatus, CodingWorkspaceMode } from '$lib/coding-environments.js';
import { decryptSecret } from '../crypto.js';
import { getDb, type Db } from '../db/index.js';
import {
	countThreadCodingConversations,
	importCodingConversation,
	listKnownThreadIds,
	listThreadCodingConversations,
	relinkOrphanedThreads,
	updateCodingConversation
} from '../db/repo/coding-conversations.js';
import {
	getCodingEnvironment,
	listEnabledCodingEnvironments,
	type CodingEnvironmentRow
} from '../db/repo/coding-environments.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { t3HttpGet, type T3Stream } from './client.js';
import { ensureFollower, getFollower } from './follower.js';
import { acquireT3Connection, type T3Lease } from './pool.js';
import {
	pushThreadState,
	reconcileThreadState,
	remoteThreadState,
	threadSettled,
	threadTitle
} from './thread-state.js';

const log = createLogger('t3-thread-sync');

export const THREAD_SYNC_INTERVAL_MS = 2 * 60 * 1000;
/** Imports per environment and pass; each one opens a follower to load its history. */
export const MAX_IMPORTS_PER_PASS = 10;
/**
 * Coding conversations (with a thread, not deleted) per environment beyond
 * which no more threads are imported, so a hostile or runaway server can't
 * grow Chatty's conversation list without bound.
 */
export const MAX_THREAD_CONVERSATIONS_PER_ENV = 200;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const time = (v: unknown): number | null => {
	const ms = Date.parse(str(v) ?? '');
	return Number.isNaN(ms) ? null : ms;
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface ImportableThread {
	threadId: string;
	projectId: string;
	projectTitle: string;
	title: string;
	providerInstanceId: string;
	model: string;
	runtimeMode: string;
	workspaceMode: CodingWorkspaceMode;
	branch: string | null;
	status: CodingTaskStatus;
	settled: boolean;
	pinned: boolean;
	/** `lastVisitedAt` in ms, 0 if never visited. */
	visitedAt: number;
	createdAt: number;
	updatedAt: number;
}

/** Titles of the live (not archived or deleted) projects in a shell snapshot, by id. */
export function shellProjects(shell: unknown): Map<string, string> {
	const projects = new Map<string, string>();
	for (const entry of list(rec(shell)?.projects)) {
		const p = rec(entry);
		const id = str(p?.id);
		if (p && id && !p.archivedAt && !p.deletedAt) {
			projects.set(id, threadTitle(p.title) ?? threadTitle(id) ?? 'Project');
		}
	}
	return projects;
}

/** Whether a shell thread is one the user started (not a subagent or delegated one). */
function isTopLevelThread(t: Rec): boolean {
	return !(
		rec(t.lineage)?.relationshipToParent === 'subagent' ||
		t.relationshipToParent === 'subagent' ||
		rec(t.delegatedFrom)
	);
}

/**
 * Reads a shell thread as an import, or null when it can't be one: deleted,
 * not top-level (subagent or delegated), outside a live project in `projects`
 * or missing what a task needs. Archived threads are read like any other.
 */
export function parseImportableThread(
	entry: unknown,
	projects: ReadonlyMap<string, string>
): ImportableThread | null {
	const t = rec(entry);
	const threadId = str(t?.id);
	if (!t || !threadId || t.deletedAt || !isTopLevelThread(t)) return null;
	const projectId = str(t.projectId);
	const projectTitle = projectId ? projects.get(projectId) : undefined;
	if (!projectId || projectTitle === undefined) return null;
	const selection = rec(t.modelSelection);
	const providerInstanceId = str(selection?.instanceId) ?? str(t.providerInstanceId);
	const model = str(selection?.model);
	const runtimeMode = str(t.runtimeMode);
	if (!providerInstanceId || !model || !runtimeMode) return null;
	const updatedAt = time(t.updatedAt) ?? time(t.createdAt);
	if (updatedAt === null) return null;
	return {
		threadId,
		projectId,
		projectTitle,
		title: threadTitle(t.title) ?? 'Coding task',
		providerInstanceId,
		model,
		runtimeMode,
		workspaceMode: str(t.worktreePath) ? 'worktree' : 'local',
		branch: str(t.branch),
		// Provisional; the follower derives the real status from the runs.
		status: rec(t.pendingRuntimeRequest)
			? 'awaiting_input'
			: str(t.activeRunId)
				? 'running'
				: 'idle',
		settled: threadSettled(t) === true,
		pinned: t.pinnedAt !== null && t.pinnedAt !== undefined,
		visitedAt: time(t.lastVisitedAt) ?? 0,
		createdAt: time(t.createdAt) ?? updatedAt,
		updatedAt
	};
}

/**
 * Threads in a shell snapshot worth importing: top-level (not subagent or
 * delegated), not archived, in a live project, unknown to Chatty and active
 * since `since` (when the environment was connected). Oldest first.
 */
export function importableThreads(
	shell: unknown,
	opts: { known: ReadonlySet<string>; since: number }
): ImportableThread[] {
	const projects = shellProjects(shell);
	const result: ImportableThread[] = [];
	for (const entry of list(rec(shell)?.threads)) {
		if (rec(entry)?.archivedAt) continue;
		const thread = parseImportableThread(entry, projects);
		if (!thread || opts.known.has(thread.threadId) || thread.updatedAt < opts.since) continue;
		result.push(thread);
	}
	return result.sort((a, b) => a.updatedAt - b.updatedAt);
}

/** How many threads `env` may still import this pass. */
export function importBudget(db: Db, environmentId: string): number {
	const room = MAX_THREAD_CONVERSATIONS_PER_ENV - countThreadCodingConversations(db, environmentId);
	return Math.max(0, Math.min(MAX_IMPORTS_PER_PASS, room));
}

const capWarned = new Set<string>();

function importThreads(db: Db, env: CodingEnvironmentRow, shell: unknown): void {
	const threadIds = new Set<string>();
	for (const entry of list(rec(shell)?.threads)) {
		const id = str(rec(entry)?.id);
		if (id) threadIds.add(id);
	}
	for (const conversationId of relinkOrphanedThreads(db, env.id, threadIds)) {
		publishServerEvent(env.user_id, { type: 'conversation.updated', conversationId });
	}
	const budget = importBudget(db, env.id);
	const importable = importableThreads(shell, {
		known: listKnownThreadIds(db, env.id),
		since: env.created_at
	});
	if (importable.length > budget && budget < MAX_IMPORTS_PER_PASS) {
		if (!capWarned.has(env.id)) {
			capWarned.add(env.id);
			log.warn('Not importing more T3 threads: environment has too many coding conversations', {
				environmentId: env.id,
				limit: MAX_THREAD_CONVERSATIONS_PER_ENV
			});
		}
	} else {
		capWarned.delete(env.id);
	}
	const threads = importable.slice(0, budget);
	let imported = 0;
	for (const thread of threads) {
		const conversationId = importCodingConversation(db, {
			userId: env.user_id,
			environmentId: env.id,
			baseBranch: null,
			...thread
		});
		if (!conversationId) continue; // linked meanwhile
		imported++;
		publishServerEvent(env.user_id, { type: 'conversation.updated', conversationId });
		void ensureFollower({
			conversationId,
			userId: env.user_id,
			env,
			threadId: thread.threadId,
			quietHistory: true
		}).follow();
	}
	if (imported > 0) {
		log.info(`Imported ${imported} thread(s) from T3`, { environmentId: env.id });
	}
}

/** Tasks whose change size was already requested by this process (one try each). */
const diffBackfilled = new Set<string>();

/** Statuses only a follower moves on from; without one, the stored value may be stale. */
const ACTIVE_STATUSES: ReadonlySet<CodingTaskStatus> = new Set([
	'starting',
	'running',
	'awaiting_input'
]);

const MISSING_THREAD_ERROR = 'The coding thread no longer exists on the coding machine';

/**
 * Follows tasks among `threads` (T3 thread shells) that need it: their thread
 * is running or waiting on T3, their stored status still says active although
 * nothing follows them (e.g. a follower gave up, or the server restarted
 * mid-run), or their change size is missing. With `onlyListed`, tasks whose
 * thread isn't among `threads` are left alone (live updates carry one thread).
 *
 * `knownThreadIds` (every thread T3 has, archived ones included) lets the full
 * pass end tasks still marked active whose thread is gone on T3: no follower
 * could ever move them on, so following them would only retry forever.
 */
function followThreads(
	db: Db,
	env: CodingEnvironmentRow,
	threads: unknown[],
	{
		onlyListed = false,
		knownThreadIds
	}: { onlyListed?: boolean; knownThreadIds?: Set<string> } = {}
): void {
	const listed = new Set<string>();
	const active = new Set<string>();
	for (const entry of threads) {
		const t = rec(entry);
		if (!t || typeof t.id !== 'string') continue;
		listed.add(t.id);
		if (str(t.activeRunId) || rec(t.pendingRuntimeRequest)) active.add(t.id);
	}
	let started = 0;
	for (const row of listThreadCodingConversations(db, env.id)) {
		if (started >= MAX_IMPORTS_PER_PASS) break;
		if (getFollower(row.conversation_id)) continue;
		if (onlyListed && !listed.has(row.thread_id!)) continue;
		const needsDiff = row.diff_insertions === null && !diffBackfilled.has(row.conversation_id);
		const staleStatus = ACTIVE_STATUSES.has(row.status);
		if (staleStatus && knownThreadIds && !knownThreadIds.has(row.thread_id!)) {
			endMissingThreadTask(db, row);
			continue;
		}
		if (!active.has(row.thread_id!) && !staleStatus && !needsDiff) continue;
		diffBackfilled.add(row.conversation_id);
		started++;
		void ensureFollower({
			conversationId: row.conversation_id,
			userId: row.user_id,
			env,
			threadId: row.thread_id
		}).follow();
	}
}

/** Reconciles the tasks on `env` whose thread is among `threads` (T3 thread shells). */
async function reconcileThreadStates(db: Db, env: CodingEnvironmentRow, threads: unknown[]) {
	const remote = new Map<string, Rec>();
	for (const entry of threads) {
		const thread = rec(entry);
		if (thread && typeof thread.id === 'string') remote.set(thread.id, thread);
	}
	if (remote.size === 0) return;
	const rows = listThreadCodingConversations(db, env.id);
	const toPush = new Map<string, string[]>();
	for (const row of rows) {
		const thread = remote.get(row.thread_id!);
		if (!thread) continue; // deleted on T3, or not listed
		// Followed tasks get remote changes live (their record is fresher than this
		// snapshot), so only retry their pending pushes.
		if (
			getFollower(row.conversation_id) ||
			reconcileThreadState(db, row.user_id, row.conversation_id, remoteThreadState(thread))
		) {
			toPush.set(row.user_id, [...(toPush.get(row.user_id) ?? []), row.conversation_id]);
		}
	}
	for (const [userId, ids] of toPush) await pushThreadState(db, userId, ids);
}

/** Ends a task still marked active whose thread no longer exists on T3. */
function endMissingThreadTask(
	db: Db,
	row: { conversation_id: string; user_id: string; thread_id: string | null }
): void {
	log.warn('Ending a coding task whose thread is gone on T3', {
		conversationId: row.conversation_id,
		threadId: row.thread_id
	});
	updateCodingConversation(db, row.conversation_id, {
		status: 'failed',
		pendingRequest: null,
		runStartedAt: null,
		lastError: MISSING_THREAD_ERROR
	});
	publishServerEvent(row.user_id, {
		type: 'coding.task.updated',
		conversationId: row.conversation_id
	});
	// Settles a coding agent run waiting on this task.
	publishServerEvent(row.user_id, {
		type: 'coding.thread.finished',
		conversationId: row.conversation_id,
		status: 'failed',
		branch: null,
		prUrl: null
	});
}

/** Ids of every thread in a T3 shell, or null when the shell has no thread lists. */
function shellThreadIds(shell: Rec | null): Set<string> | null {
	if (!Array.isArray(shell?.threads) || !Array.isArray(shell?.archivedThreads)) return null;
	const ids = new Set<string>();
	for (const entry of [...shell.threads, ...shell.archivedThreads]) {
		const t = rec(entry);
		if (t && typeof t.id === 'string') ids.add(t.id);
	}
	return ids;
}

/** Loads `env`'s thread list (T3's shell snapshot, archived threads included). */
export async function loadShell(env: CodingEnvironmentRow): Promise<Rec | null> {
	return rec(
		await t3HttpGet(
			env.base_url,
			decryptSecret(env.token_enc),
			'/api/orchestration/shell?omitIdleSubagents=1'
		)
	);
}

/**
 * Whether `env` (read before an await) is still enabled with the same URL and
 * token, so work done with it doesn't revive followers on old credentials.
 */
export function isCurrentEnvironment(db: Db, env: CodingEnvironmentRow): boolean {
	const current = getCodingEnvironment(db, env.user_id, env.id);
	return (
		current?.enabled === 1 &&
		current.base_url === env.base_url &&
		current.token_enc === env.token_enc
	);
}

/** Lets `stopThreadSync` cut short a pass that is still running (shutdown). */
export interface ThreadSyncPass {
	cancelled: boolean;
}

export async function syncAllThreads(
	db: Db = getDb(),
	pass: ThreadSyncPass = { cancelled: false }
): Promise<void> {
	const envs = listEnabledCodingEnvironments(db);
	syncShellWatchers(db, envs);
	for (const env of envs) {
		if (pass.cancelled) return;
		let shell: Rec | null;
		try {
			shell = await loadShell(env);
		} catch (e) {
			log.warn('Could not load T3 threads', {
				environmentId: env.id,
				error: e instanceof Error ? e.message : String(e)
			});
			continue;
		}
		if (pass.cancelled) return;
		// The environment may have been disabled, edited or removed meanwhile.
		if (!isCurrentEnvironment(db, env)) continue;
		try {
			importThreads(db, env, shell);
			followThreads(db, env, list(shell?.threads), {
				knownThreadIds: shellThreadIds(shell) ?? undefined
			});
			await reconcileThreadStates(db, env, [
				...list(shell?.threads),
				...list(shell?.archivedThreads)
			]);
		} catch (e) {
			log.error('Thread sync failed', {
				environmentId: env.id,
				error: e instanceof Error ? e.message : String(e)
			});
		}
	}
}

// ── live shell watch ─────────────────────────────────────────────────────
// Tasks without a follower (idle ones) would otherwise only see a change made
// on T3 (settle, pin, rename, read) on the next periodic pass. Each enabled
// environment keeps a shell subscription open and reconciles a task as soon as
// T3 reports its thread changed; the periodic pass still covers anything
// missed while disconnected.

const SHELL_RECONNECT_MIN_MS = 2000;
const SHELL_RECONNECT_MAX_MS = 60_000;
/** Delay before importing a thread the live watch reported but Chatty doesn't know. */
export const LIVE_IMPORT_DEBOUNCE_MS = 5000;

/** Whether `threads` (T3 thread shells) include a top-level live thread Chatty doesn't know. */
function hasUnknownThread(db: Db, env: CodingEnvironmentRow, threads: unknown[]): boolean {
	const candidates = threads.filter((entry) => {
		const t = rec(entry);
		const activeAt = time(t?.updatedAt) ?? time(t?.createdAt);
		return (
			!!t &&
			!!str(t.id) &&
			!t.deletedAt &&
			!t.archivedAt &&
			isTopLevelThread(t) &&
			// Older threads are only imported from the history on request.
			activeAt !== null &&
			activeAt >= env.created_at
		);
	});
	if (candidates.length === 0) return false;
	const known = listKnownThreadIds(db, env.id);
	return candidates.some((t) => !known.has(String(rec(t)!.id)));
}

class ShellWatcher {
	private lease: T3Lease | null = null;
	private stream: T3Stream | null = null;
	private importTimer: ReturnType<typeof setTimeout> | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private retryDelay = SHELL_RECONNECT_MIN_MS;
	private stopped = false;
	private warned = false;

	constructor(
		private readonly db: Db,
		readonly env: CodingEnvironmentRow
	) {}

	start(): void {
		void this.connect();
	}

	stop(): void {
		this.stopped = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		if (this.importTimer) clearTimeout(this.importTimer);
		this.importTimer = null;
		this.stream?.cancel();
		this.stream = null;
		this.lease?.release();
		this.lease = null;
	}

	private async connect(): Promise<void> {
		if (this.stopped) return;
		try {
			this.lease ??= acquireT3Connection(this.env);
			const conn = await this.lease.connection();
			if (this.stopped || this.stream) return;
			// The stream also ends when the shared socket closes; the next attempt
			// reconnects it (or reuses it, if someone else already did).
			const stream = conn.stream(
				'orchestration.subscribeShell',
				{ omitIdleSubagents: true, omitOlderSettled: true },
				{
					onValue: (value) => {
						this.retryDelay = SHELL_RECONNECT_MIN_MS;
						this.warned = false;
						this.onItem(value);
					},
					onEnd: (error) => {
						if (this.stream === stream) this.stream = null;
						if (error) this.warn(error);
						this.scheduleRetry();
					}
				}
			);
			this.stream = stream;
		} catch (e) {
			this.warn(e);
			this.scheduleRetry();
		}
	}

	private onItem(value: unknown): void {
		const item = rec(value);
		let threads: unknown[];
		if (item?.kind === 'snapshot') {
			// Sent on every (re)connect: catches up on whatever changed while the
			// watch was down, instead of waiting for the periodic pass.
			threads = list(rec(item.snapshot)?.threads);
		} else if (item?.kind === 'thread.updated' && rec(item.thread)) {
			threads = [item.thread];
		} else {
			return;
		}
		// A run started on T3 (or finished there) shows up right away rather
		// than on the next periodic pass; the follower keeps the status current.
		const sync = async () => {
			if (this.stopped || !isCurrentEnvironment(this.db, this.env)) return;
			if (hasUnknownThread(this.db, this.env, threads)) this.scheduleImport();
			followThreads(this.db, this.env, threads, { onlyListed: true });
			await reconcileThreadStates(this.db, this.env, threads);
		};
		sync().catch((e) =>
			log.error('Live thread sync failed', {
				environmentId: this.env.id,
				error: e instanceof Error ? e.message : String(e)
			})
		);
	}

	/**
	 * Imports new threads soon after T3 first reports them, rather than on the
	 * next periodic pass. Debounced: a new thread comes with a burst of updates.
	 */
	private scheduleImport(): void {
		if (this.stopped || this.importTimer) return;
		this.importTimer = setTimeout(() => {
			this.importTimer = null;
			const run = async () => {
				const shell = await loadShell(this.env);
				if (this.stopped || !isCurrentEnvironment(this.db, this.env)) return;
				importThreads(this.db, this.env, shell);
			};
			run().catch((e) =>
				log.warn('Could not import new T3 threads', {
					environmentId: this.env.id,
					error: e instanceof Error ? e.message : String(e)
				})
			);
		}, LIVE_IMPORT_DEBOUNCE_MS);
		this.importTimer.unref?.();
	}

	private scheduleRetry(): void {
		if (this.stopped || this.retryTimer) return;
		const delay = this.retryDelay;
		this.retryDelay = Math.min(delay * 2, SHELL_RECONNECT_MAX_MS);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			void this.connect();
		}, delay);
		this.retryTimer.unref?.();
	}

	private warn(e: unknown): void {
		if (this.warned) return;
		this.warned = true;
		log.warn('Lost the live thread list of a coding environment', {
			environmentId: this.env.id,
			error: e instanceof Error ? e.message : String(e)
		});
	}
}

const watchers = new Map<string, ShellWatcher>();
const watcherKey = (env: CodingEnvironmentRow) => `${env.base_url}\n${env.token_enc}`;

/** Watches exactly the given environments, restarting watchers whose URL or token changed. */
function syncShellWatchers(db: Db, envs: readonly CodingEnvironmentRow[]): void {
	const wanted = new Map(envs.map((env) => [env.id, env]));
	for (const [id, watcher] of watchers) {
		const env = wanted.get(id);
		if (!env || watcherKey(env) !== watcherKey(watcher.env)) {
			watcher.stop();
			watchers.delete(id);
		}
	}
	for (const env of envs) {
		if (watchers.has(env.id)) continue;
		const watcher = new ShellWatcher(db, env);
		watchers.set(env.id, watcher);
		watcher.start();
	}
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let currentPass: ThreadSyncPass | null = null;

/**
 * Re-applies the live thread watch right after an environment was edited or
 * removed, so no watcher keeps using an old URL or token until the next pass.
 */
export function refreshShellWatchers(db: Db = getDb()): void {
	if (!timer) return; // thread sync isn't running (tests, shutdown)
	syncShellWatchers(db, listEnabledCodingEnvironments(db));
}

export function startThreadSync(db: Db = getDb()): void {
	if (timer) return;
	const tick = () => {
		if (running) return;
		running = true;
		const pass: ThreadSyncPass = { cancelled: false };
		currentPass = pass;
		syncAllThreads(db, pass)
			.catch((e) =>
				log.error('Thread sync failed', {
					error: e instanceof Error ? e.message : String(e)
				})
			)
			.finally(() => {
				running = false;
				if (currentPass === pass) currentPass = null;
			});
	};
	tick();
	timer = setInterval(tick, THREAD_SYNC_INTERVAL_MS);
	timer.unref?.();
}

export function stopThreadSync(): void {
	if (timer) clearInterval(timer);
	timer = null;
	if (currentPass) currentPass.cancelled = true;
	currentPass = null;
	for (const watcher of watchers.values()) watcher.stop();
	watchers.clear();
}
