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
	relinkOrphanedThreads
} from '../db/repo/coding-conversations.js';
import {
	listEnabledCodingEnvironments,
	type CodingEnvironmentRow
} from '../db/repo/coding-environments.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { connectT3, t3HttpGet, type T3Connection, type T3Stream } from './client.js';
import { ensureFollower, getFollower } from './follower.js';
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

/**
 * Threads in a shell snapshot worth importing: top-level (not subagent or
 * delegated), not archived, in a live project, unknown to Chatty and active
 * since `since` (when the environment was connected). Oldest first.
 */
export function importableThreads(
	shell: unknown,
	opts: { known: ReadonlySet<string>; since: number }
): ImportableThread[] {
	const s = rec(shell);
	const projects = new Map<string, string>();
	for (const entry of Array.isArray(s?.projects) ? s.projects : []) {
		const p = rec(entry);
		const id = str(p?.id);
		if (p && id && !p.archivedAt && !p.deletedAt) {
			projects.set(id, threadTitle(p.title) ?? threadTitle(id) ?? 'Project');
		}
	}
	const result: ImportableThread[] = [];
	for (const entry of Array.isArray(s?.threads) ? s.threads : []) {
		const t = rec(entry);
		const threadId = str(t?.id);
		if (!t || !threadId || opts.known.has(threadId)) continue;
		if (t.archivedAt || t.deletedAt) continue;
		const lineage = rec(t.lineage);
		if (
			lineage?.relationshipToParent === 'subagent' ||
			t.relationshipToParent === 'subagent' ||
			rec(t.delegatedFrom)
		) {
			continue;
		}
		const projectId = str(t.projectId);
		const projectTitle = projectId ? projects.get(projectId) : undefined;
		if (!projectId || projectTitle === undefined) continue;
		const selection = rec(t.modelSelection);
		const providerInstanceId = str(selection?.instanceId) ?? str(t.providerInstanceId);
		const model = str(selection?.model);
		const runtimeMode = str(t.runtimeMode);
		if (!providerInstanceId || !model || !runtimeMode) continue;
		const updatedAt = time(t.updatedAt) ?? time(t.createdAt);
		if (updatedAt === null || updatedAt < opts.since) continue;
		result.push({
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
		});
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
	for (const thread of threads) {
		const conversationId = importCodingConversation(db, {
			userId: env.user_id,
			environmentId: env.id,
			baseBranch: null,
			...thread
		});
		publishServerEvent(env.user_id, { type: 'conversation.updated', conversationId });
		void ensureFollower({
			conversationId,
			userId: env.user_id,
			env,
			threadId: thread.threadId,
			quietHistory: true
		}).follow();
	}
	if (threads.length > 0) {
		log.info(`Imported ${threads.length} thread(s) from T3`, { environmentId: env.id });
	}
}

/** Tasks whose change size was already requested by this process (one try each). */
const diffBackfilled = new Set<string>();

function followActiveThreads(db: Db, env: CodingEnvironmentRow, shell: Rec | null): void {
	const active = new Set<string>();
	for (const entry of Array.isArray(shell?.threads) ? shell.threads : []) {
		const t = rec(entry);
		if (t && typeof t.id === 'string' && (str(t.activeRunId) || rec(t.pendingRuntimeRequest))) {
			active.add(t.id);
		}
	}
	let started = 0;
	for (const row of listThreadCodingConversations(db, env.id)) {
		if (started >= MAX_IMPORTS_PER_PASS) break;
		if (getFollower(row.conversation_id)) continue;
		const needsDiff = row.diff_insertions === null && !diffBackfilled.has(row.conversation_id);
		if (!active.has(row.thread_id!) && !needsDiff) continue;
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

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export async function syncAllThreads(db: Db = getDb()): Promise<void> {
	const envs = listEnabledCodingEnvironments(db);
	syncShellWatchers(db, envs);
	for (const env of envs) {
		let shell: Rec | null;
		try {
			shell = rec(
				await t3HttpGet(
					env.base_url,
					decryptSecret(env.token_enc),
					'/api/orchestration/shell?omitIdleSubagents=1'
				)
			);
		} catch (e) {
			log.warn('Could not load T3 threads', {
				environmentId: env.id,
				error: e instanceof Error ? e.message : String(e)
			});
			continue;
		}
		try {
			importThreads(db, env, shell);
			followActiveThreads(db, env, shell);
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

class ShellWatcher {
	private conn: T3Connection | null = null;
	private stream: T3Stream | null = null;
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
		this.disconnect();
	}

	private disconnect(): void {
		const conn = this.conn;
		this.stream?.cancel();
		this.stream = null;
		this.conn = null;
		conn?.close();
	}

	private async connect(): Promise<void> {
		if (this.stopped) return;
		try {
			const conn = await connectT3(this.env.base_url, decryptSecret(this.env.token_enc));
			if (this.stopped) {
				conn.close();
				return;
			}
			this.conn = conn;
			this.stream = conn.stream(
				'orchestration.subscribeShell',
				{ omitIdleSubagents: true, omitOlderSettled: true },
				{
					onValue: (value) => {
						this.retryDelay = SHELL_RECONNECT_MIN_MS;
						this.warned = false;
						this.onItem(value);
					},
					onEnd: (error) => {
						this.stream = null;
						if (error) this.warn(error);
						this.disconnect();
						this.scheduleRetry();
					}
				}
			);
		} catch (e) {
			this.warn(e);
			this.scheduleRetry();
		}
	}

	private onItem(value: unknown): void {
		const item = rec(value);
		// Snapshots (on connect) are left to the periodic pass.
		if (item?.kind !== 'thread.updated' || !rec(item.thread)) return;
		reconcileThreadStates(this.db, this.env, [item.thread]).catch((e) =>
			log.error('Live thread sync failed', {
				environmentId: this.env.id,
				error: e instanceof Error ? e.message : String(e)
			})
		);
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
		syncAllThreads(db).finally(() => {
			running = false;
		});
	};
	tick();
	timer = setInterval(tick, THREAD_SYNC_INTERVAL_MS);
	timer.unref?.();
}

export function stopThreadSync(): void {
	if (timer) clearInterval(timer);
	timer = null;
	for (const watcher of watchers.values()) watcher.stop();
	watchers.clear();
}
