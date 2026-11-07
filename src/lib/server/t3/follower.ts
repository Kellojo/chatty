// Follows one coding task's T3 Code thread and mirrors it into Chatty:
// - live: the active run streams into the chat stream registry as UI message
//   chunks, so the normal chat UI (resume, Stop, sidebar spinner) just works;
// - persisted: every run's reply is written as an assistant message;
// - task state (status, branch, PR, pending approval/question) goes to
//   `coding_conversations` and is announced with `coding.task.updated`.
//
// One follower per conversation, kept alive while the task is active and for a
// grace period after it goes idle. It reconnects with backoff if the socket drops,
// and gives up after MAX_FAILED_ATTEMPTS attempts in a row that never got the
// thread (unreachable server, or one that never sends a snapshot) — more while
// a Chatty turn is live; thread sync and the next turn re-create it on demand.

import { randomUUID } from 'node:crypto';
import type { UIMessageChunk } from 'ai';
import {
	appendChunk,
	getStreamStartedAt,
	hasActiveStream,
	markDone,
	registerStream,
	releaseStream
} from '../chat/streams.js';
import { decryptSecret } from '../crypto.js';
import { getDb, type Db } from '../db/index.js';
import {
	getCodingConversation,
	updateCodingConversation
} from '../db/repo/coding-conversations.js';
import type { CodingEnvironmentRow } from '../db/repo/coding-environments.js';
import { getConversation, touchConversation } from '../db/repo/conversations.js';
import { createMessage, getMessage, updateMessage } from '../db/repo/messages.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { connectT3, t3HttpGet, T3ClientError, type T3Connection, type T3Stream } from './client.js';
import { parseDiffStat } from './diff.js';
import {
	activeRun,
	applyStreamItem,
	emptyThreadState,
	hasRunningSubagent,
	isAgentNotification,
	isRunActive,
	isRunFinished,
	runItemsEvicted,
	MAX_THREAD_RECORDS,
	messageText,
	renderRun,
	replyMessageId,
	runFailureText,
	sortedRuns,
	streamItemRun,
	summarizeTask,
	type RenderedEntry,
	type ThreadState
} from './projection.js';
import { queueThreadStatePush, reconcileThreadState, remoteThreadState } from './thread-state.js';

const log = createLogger('t3-follower');

const RENDER_DEBOUNCE_MS = 120;
const PERSIST_INTERVAL_MS = 1000;
const IDLE_STOP_MS = 5 * 60 * 1000;
const MIN_RECONNECT_MS = 2000;
const MAX_RECONNECT_MS = 60_000;
/** Consecutive attempts without a snapshot before the follower gives up (~4 min of backoff). */
export const MAX_FAILED_ATTEMPTS = 8;
/** The same, while a Chatty turn is live (~15 min): a reply can't spin forever. */
export const MAX_FAILED_ATTEMPTS_LIVE = 20;
/** How long a turn may wait for its remote run to show up before it ends with an error. */
export const UNBOUND_TURN_TIMEOUT_MS = 10 * 60 * 1000;
export const UNBOUND_TURN_ERROR = 'The coding agent did not start working on this message.';
export const RUN_GONE_ERROR = 'The coding task’s run is no longer available.';
/** Spacing and number of retries for omitted command output that failed to load. */
const OUTPUT_RETRY_MS = 30_000;
const MAX_OUTPUT_ATTEMPTS = 3;
/** How long a subscription may stay silent before the attempt counts as failed. */
export const SNAPSHOT_TIMEOUT_MS = 30_000;
export const GAVE_UP_ERROR =
	'Lost connection to the coding environment. Send a message to reconnect.';
const MAX_OUTPUT_CHARS = 16_000;
/** Only fetch omitted command output for the most recent runs. */
const OUTPUT_FETCH_RUNS = 3;
/** Wait for edits to settle before re-reading the change size. */
const DIFF_DEBOUNCE_MS = 2000;

type Rec = Record<string, unknown>;

interface EmittedPart {
	started: boolean;
	sent: string;
	ended: boolean;
}

interface LiveTurn {
	controller: AbortController;
	messageId: string;
	userMessageId: string | null;
	runId: string | null;
	interruptWhenBound: boolean;
	emitted: Map<string, EmittedPart>;
	/** Ends the turn if it never binds to a run; see {@link UNBOUND_TURN_TIMEOUT_MS}. */
	bindTimer: ReturnType<typeof setTimeout> | null;
}

const notFollowedError = () =>
	new T3ClientError('This coding task is no longer connected', 'protocol');

let shuttingDown = false;
const followers = new Map<string, CodingFollower>();

export class CodingFollower {
	private state: ThreadState = emptyThreadState();
	private conn: T3Connection | null = null;
	private connecting: Promise<T3Connection> | null = null;
	private stream: T3Stream | null = null;
	private stopped = false;
	private reconnectDelay = MIN_RECONNECT_MS;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	/** Subscription attempts in a row that ended without a snapshot. */
	private failedAttempts = 0;
	/** Whether the current (or last) subscription attempt received a snapshot. */
	private attemptGotSnapshot = false;
	private renderTimer: ReturnType<typeof setTimeout> | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private live: LiveTurn | null = null;
	private readonly persisted = new Map<string, { json: string; at: number; status: string }>();
	private readonly commandOutputs = new Map<string, string>();
	private readonly fetchingOutputs = new Set<string>();
	/** Omitted outputs whose fetch failed: when last tried, and how often. */
	private readonly failedOutputs = new Map<string, { at: number; attempts: number }>();
	/**
	 * Runs whose parts may have changed since they were last rendered. Rendering
	 * is synchronous and grows with the run's size, so re-rendering a long
	 * thread's whole history on every streamed delta stalls the event loop.
	 */
	private readonly dirtyRuns = new Set<string>();
	private allRunsDirty = true;
	private lastSummaryJson = '';
	private lastStatus: string | null = null;
	private lastRemoteStateJson: string | null = null;
	private diffKey: string | null = null;
	private diffTimer: ReturnType<typeof setTimeout> | null = null;
	private diffInFlight = false;
	private diffWarned = false;
	/** Project checkout path, for tasks without a worktree; undefined = not looked up yet. */
	private projectRoot: string | null | undefined = undefined;
	private hasSnapshot = false;
	/** Imported thread: its first render is past history and must not bump the chat. */
	private quietHistory: boolean;

	constructor(
		readonly conversationId: string,
		readonly userId: string,
		private env: CodingEnvironmentRow,
		private threadId: string | null,
		private readonly db: Db = getDb(),
		opts: { quietHistory?: boolean } = {}
	) {
		this.quietHistory = opts.quietHistory === true;
		const row = getCodingConversation(db, conversationId);
		this.lastStatus = row?.status ?? null;
	}

	// ── connection ──────────────────────────────────────────────────────

	/** Opens (or reuses) the socket. Commands and the subscription share it. */
	private connection(): Promise<T3Connection> {
		// A stopped follower must not reopen a socket with credentials that may
		// have just been removed or replaced.
		if (this.stopped) return Promise.reject(notFollowedError());
		if (this.conn && !this.conn.closed) return Promise.resolve(this.conn);
		this.connecting ??= connectT3(this.env.base_url, decryptSecret(this.env.token_enc))
			.then((conn) => {
				if (this.stopped) {
					conn.close();
					throw notFollowedError();
				}
				this.conn = conn;
				conn.onClose(() => {
					if (this.conn === conn) this.conn = null;
					this.stream = null;
					this.scheduleReconnect();
				});
				return conn;
			})
			.finally(() => {
				this.connecting = null;
			});
		return this.connecting;
	}

	/** Starts following the thread (idempotent). */
	async follow(): Promise<void> {
		if (this.stopped || !this.threadId) return;
		this.cancelIdleStop();
		if (this.stream) {
			// Already following: a render re-arms the idle stop from now, if due.
			if (this.hasSnapshot) this.scheduleRender();
			return;
		}
		await this.subscribe();
	}

	/**
	 * Opens the thread subscription. Reconnects come through here rather than
	 * {@link follow}, so they don't hold off the idle stop.
	 */
	private async subscribe(): Promise<void> {
		if (this.stopped || !this.threadId || this.stream) return;
		this.attemptGotSnapshot = false;
		try {
			const conn = await this.connection();
			if (this.stream || this.stopped) return;
			const stream = conn.stream(
				'orchestration.subscribeThread',
				{ threadId: this.threadId },
				{
					onValue: (value) => {
						if (applyStreamItem(this.state, value)) {
							this.markDirty(streamItemRun(value));
							if ((value as Rec)?.kind === 'snapshot') {
								this.hasSnapshot = true;
								this.attemptGotSnapshot = true;
								this.failedAttempts = 0;
								this.reconnectDelay = MIN_RECONNECT_MS;
								this.clearSnapshotTimer();
							}
							this.scheduleRender();
						}
					},
					onEnd: (error) => {
						if (this.stopped) return;
						if (this.stream === stream) this.stream = null;
						this.clearSnapshotTimer();
						if (error) this.recordError(error);
						this.scheduleReconnect();
					}
				}
			);
			this.stream = stream;
			// A server that accepts the subscription but never sends the thread
			// would otherwise keep this follower (and its socket) forever.
			this.clearSnapshotTimer();
			this.snapshotTimer = setTimeout(() => {
				this.snapshotTimer = null;
				if (this.attemptGotSnapshot || this.stream !== stream) return;
				stream.cancel();
				this.stream = null;
				this.recordError(
					new T3ClientError('The coding environment did not send the task', 'remote')
				);
				this.scheduleReconnect();
			}, SNAPSHOT_TIMEOUT_MS);
			this.snapshotTimer.unref?.();
		} catch (e) {
			// Stopped while connecting: deliberate, not a connection problem.
			if (this.stopped) return;
			this.recordError(e);
			this.scheduleReconnect();
		}
	}

	private clearSnapshotTimer(): void {
		if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
		this.snapshotTimer = null;
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer || !this.threadId) return;
		if (!this.attemptGotSnapshot) this.failedAttempts++;
		const limit = this.live ? MAX_FAILED_ATTEMPTS_LIVE : MAX_FAILED_ATTEMPTS;
		if (this.failedAttempts >= limit) {
			this.giveUp();
			return;
		}
		const delay = this.reconnectDelay;
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.subscribe();
		}, delay);
		this.reconnectTimer.unref?.();
	}

	/** Stops after repeated failed attempts; see the header comment. */
	private giveUp(): void {
		log.warn('Giving up on a coding task after repeated connection failures', {
			conversationId: this.conversationId,
			attempts: this.failedAttempts
		});
		this.recordError(new T3ClientError(GAVE_UP_ERROR, 'unreachable'));
		this.stop(GAVE_UP_ERROR);
	}

	private recordError(e: unknown): void {
		const message =
			e instanceof T3ClientError ? e.message : 'Lost connection to the coding environment';
		log.warn('Coding task connection problem', {
			conversationId: this.conversationId,
			error: e instanceof Error ? e.message : String(e)
		});
		const row = getCodingConversation(this.db, this.conversationId);
		if (row && row.last_error !== message) {
			updateCodingConversation(this.db, this.conversationId, { lastError: message });
			publishServerEvent(this.userId, {
				type: 'coding.task.updated',
				conversationId: this.conversationId
			});
		}
	}

	/**
	 * Stops following. A reply still streaming is ended locally (with `reason`
	 * as its error, if given); the remote run is left alone and keeps going on
	 * T3, where the next follower for the task picks it up again.
	 */
	stop(reason?: string): void {
		if (this.stopped) return;
		this.stopped = true;
		this.pendingInterruptFor = null;
		this.endLive({
			interrupted: true,
			errorText: reason,
			settleError: reason ?? 'Response interrupted'
		});
		this.cancelIdleStop();
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.clearSnapshotTimer();
		if (this.renderTimer) clearTimeout(this.renderTimer);
		if (this.diffTimer) clearTimeout(this.diffTimer);
		this.stream?.cancel();
		this.stream = null;
		this.conn?.close();
		this.conn = null;
		if (followers.get(this.conversationId) === this) followers.delete(this.conversationId);
	}

	get environmentId(): string {
		return this.env.id;
	}

	updateEnvironment(env: CodingEnvironmentRow): void {
		this.env = env;
	}

	// ── commands ────────────────────────────────────────────────────────

	private async rpc(tag: string, payload: unknown): Promise<unknown> {
		const conn = await this.connection();
		return conn.call(tag, payload);
	}

	async launch(input: {
		threadId: string;
		projectId: string;
		title: string;
		modelSelection: { instanceId: string; model: string };
		runtimeMode: string;
		workspaceStrategy: Rec;
		message: { id: string; text: string };
	}): Promise<void> {
		this.threadId = input.threadId;
		await this.rpc('orchestration.launchThread', {
			commandId: randomUUID(),
			threadId: input.threadId,
			projectId: input.projectId,
			title: input.title,
			generateTitle: true,
			creationSource: 'web',
			modelSelection: input.modelSelection,
			runtimeMode: input.runtimeMode,
			interactionMode: 'default',
			workspaceStrategy: input.workspaceStrategy,
			initialMessage: { messageId: input.message.id, text: input.message.text, attachments: [] }
		});
	}

	async sendMessage(message: { id: string; text: string }): Promise<void> {
		if (!this.threadId) throw new T3ClientError('Task has no thread yet', 'protocol');
		const busy = activeRun(this.state) !== null;
		await this.rpc('orchestration.dispatchCommand', {
			type: 'message.dispatch',
			commandId: randomUUID(),
			createdBy: 'user',
			creationSource: 'web',
			threadId: this.threadId,
			messageId: message.id,
			text: message.text,
			attachments: [],
			...(busy
				? { dispatchMode: { type: 'queue_after_active' } }
				: { deliveryIntent: 'auto', dispatchMode: { type: 'start_immediately' } })
		});
	}

	async respond(input: {
		requestId: string;
		decision?: string;
		answers?: Record<string, string>;
		feedback?: string;
	}): Promise<void> {
		if (!this.threadId) throw new T3ClientError('Task has no thread yet', 'protocol');
		await this.rpc('orchestration.dispatchCommand', {
			type: 'runtime-request.respond',
			commandId: randomUUID(),
			threadId: this.threadId,
			requestId: input.requestId,
			...(input.decision ? { decision: input.decision } : {}),
			...(input.answers ? { answers: input.answers } : {}),
			...(input.feedback ? { feedback: input.feedback } : {})
		});
	}

	/**
	 * Run the user stopped here. Until T3 reports it ended, renders must not
	 * reopen a live stream for it (that would undo the Stop).
	 */
	private interruptedRunId: string | null = null;

	private interruptRun(runId: string): void {
		if (!this.threadId || this.stopped) return;
		this.interruptedRunId = runId;
		this.rpc('orchestration.dispatchCommand', {
			type: 'run.interrupt',
			commandId: randomUUID(),
			threadId: this.threadId,
			runId,
			holdQueue: true
		}).catch((e) => {
			// The run keeps going; let the next render show it streaming again.
			if (this.interruptedRunId === runId) this.interruptedRunId = null;
			this.recordError(e);
		});
	}

	// ── live turn (stream registry) ─────────────────────────────────────

	/**
	 * Opens the chat stream for the reply to `userMessageId` before the remote
	 * run exists, so the POST /api/chat response can attach to it immediately.
	 */
	beginTurn(userMessageId: string): void {
		// A reply still streaming for an earlier message keeps updating in the
		// DB; only its live stream is handed over to the new turn.
		if (this.live) this.endLive({ interrupted: false });
		// A pending idle stop would end this turn while it is being sent.
		this.cancelIdleStop();
		this.openLive(this.localMessageId(`${userMessageId}:reply`), userMessageId, null);
	}

	/** Ends a turn that never started remotely (e.g. launch failed). */
	failTurn(): void {
		const live = this.live;
		if (!live || live.runId) return;
		this.endLive({ interrupted: false });
		const row = this.ownMessage(live.messageId);
		if (row && row.parts === '[]') {
			this.db
				.prepare('DELETE FROM messages WHERE id = ? AND conversation_id = ?')
				.run(live.messageId, this.conversationId);
		}
	}

	/**
	 * Message ids are derived from data the remote T3 server controls (run
	 * userMessageIds), so a row is only ours to touch if it belongs to this
	 * conversation — otherwise a hostile or shared T3 server could overwrite
	 * another conversation's (or user's) messages.
	 */
	private ownMessage(id: string): ReturnType<typeof getMessage> {
		const row = getMessage(this.db, id);
		return row && row.conversation_id === this.conversationId ? row : undefined;
	}

	private isForeignMessage(id: string): boolean {
		const row = getMessage(this.db, id);
		return !!row && row.conversation_id !== this.conversationId;
	}

	/**
	 * The row id for a message id derived from the thread. Several conversations
	 * can follow the same thread (e.g. two users connected to one T3 server), and
	 * message ids are global: once another conversation holds the plain id, this
	 * one stores the message under an id scoped to itself instead. A scoped row
	 * that already exists wins, so the choice stays stable when the other
	 * conversation goes away.
	 */
	private localMessageId(remoteId: string): string {
		const scoped = `${this.conversationId}:${remoteId}`;
		if (this.ownMessage(scoped)) return scoped;
		return this.isForeignMessage(remoteId) ? scoped : remoteId;
	}

	private openLive(messageId: string, userMessageId: string | null, runId: string | null): void {
		if (this.isForeignMessage(messageId)) {
			log.warn('t3 reply id collides with another conversation; not streaming', {
				conversationId: this.conversationId
			});
			return;
		}
		const controller = new AbortController();
		registerStream(this.conversationId, controller);
		const turn: LiveTurn = {
			controller,
			messageId,
			userMessageId,
			runId,
			interruptWhenBound: false,
			emitted: new Map(),
			bindTimer: null
		};
		this.live = turn;
		if (!runId) this.armBindTimer(turn);
		if (!getMessage(this.db, messageId)) {
			createMessage(this.db, {
				id: messageId,
				conversationId: this.conversationId,
				role: 'assistant',
				parts: [],
				status: 'partial'
			});
			// A new reply means a new turn (e.g. one started on T3 itself, with no
			// local user message): it orders the sidebar like a sent message does.
			if (!this.quietHistory) touchConversation(this.db, this.conversationId);
		} else {
			updateMessage(this.db, messageId, { status: 'partial', error: null });
		}
		appendChunk(this.conversationId, { type: 'start', messageId }, controller);
		publishServerEvent(this.userId, {
			type: 'chat.stream.started',
			conversationId: this.conversationId,
			startedAt: getStreamStartedAt(this.conversationId) ?? Date.now()
		});
		controller.signal.addEventListener('abort', () => this.onLiveAborted(turn), { once: true });
	}

	private onLiveAborted(turn: LiveTurn): void {
		if (this.live !== turn) return;
		// On shutdown the remote agent keeps working; we pick it up on restart.
		if (!shuttingDown) {
			if (turn.runId) this.interruptRun(turn.runId);
			else turn.interruptWhenBound = true;
		}
		if (turn.interruptWhenBound && !shuttingDown) {
			// Keep the turn registered until the run appears, then interrupt it.
			this.endLive({ interrupted: true, keepPendingInterrupt: true });
			return;
		}
		this.endLive({ interrupted: true });
	}

	private pendingInterruptFor: string | null = null;

	/**
	 * Ends a turn still waiting for its run after {@link UNBOUND_TURN_TIMEOUT_MS}.
	 * A message queued behind another active run may legitimately wait longer.
	 */
	private armBindTimer(turn: LiveTurn): void {
		turn.bindTimer = setTimeout(() => {
			turn.bindTimer = null;
			if (this.live !== turn || turn.runId) return;
			if (this.hasSnapshot && activeRun(this.state)) {
				this.armBindTimer(turn);
				return;
			}
			this.endLive({
				interrupted: true,
				errorText: UNBOUND_TURN_ERROR,
				settleError: UNBOUND_TURN_ERROR
			});
		}, UNBOUND_TURN_TIMEOUT_MS);
		turn.bindTimer.unref?.();
	}

	private endLive(opts: {
		interrupted: boolean;
		errorText?: string;
		keepPendingInterrupt?: boolean;
		/**
		 * The follower lets go of a run that hasn't finished: a reply still marked
		 * partial is settled as failed with this error, as a dead response would
		 * be (see finalizeInterruptedMessages). Not on shutdown, where the run is
		 * picked up again on restart.
		 */
		settleError?: string;
	}): void {
		const turn = this.live;
		if (!turn) return;
		this.live = null;
		if (turn.bindTimer) clearTimeout(turn.bindTimer);
		turn.bindTimer = null;
		if (opts.keepPendingInterrupt && turn.userMessageId) {
			this.pendingInterruptFor = turn.userMessageId;
		}
		if (
			opts.settleError &&
			!shuttingDown &&
			this.ownMessage(turn.messageId)?.status === 'partial'
		) {
			updateMessage(this.db, turn.messageId, { status: 'failed', error: opts.settleError });
			// A later render of the run must write its state again.
			this.persisted.delete(turn.messageId);
		}
		const emit = (chunk: UIMessageChunk) =>
			appendChunk(this.conversationId, chunk, turn.controller);
		for (const [key, part] of turn.emitted) {
			if (!key.startsWith('x:') && part.started && !part.ended) {
				const kind = key.startsWith('r:') ? 'reasoning' : 'text';
				emit({ type: `${kind}-end`, id: key.slice(2) } as UIMessageChunk);
			}
		}
		if (opts.errorText) emit({ type: 'error', errorText: opts.errorText });
		emit({ type: 'finish' });
		markDone(this.conversationId, turn.controller);
		releaseStream(this.conversationId, turn.controller);
		publishServerEvent(this.userId, {
			type: 'chat.stream.finished',
			conversationId: this.conversationId
		});
		// The idle stop is held off while a turn is live; re-check it now.
		if (this.hasSnapshot) this.scheduleRender();
	}

	/** Emits the chunks that turn what the client has seen into `entries`. */
	private emitDiff(turn: LiveTurn, entries: RenderedEntry[]): void {
		const emit = (chunk: UIMessageChunk) =>
			appendChunk(this.conversationId, chunk, turn.controller);
		for (const { key, part } of entries) {
			if (part.type === 'text' || part.type === 'reasoning') {
				const kind = part.type;
				const emittedKey = `${kind === 'reasoning' ? 'r' : 't'}:${key}`;
				let rec = turn.emitted.get(emittedKey);
				if (!rec) {
					rec = { started: true, sent: '', ended: false };
					turn.emitted.set(emittedKey, rec);
					emit({ type: `${kind}-start`, id: key } as UIMessageChunk);
				}
				// T3 sends cumulative text; forward only what's new. A non-append
				// rewrite can't be expressed as a delta — the persisted message
				// (reloaded when the stream finishes) has the correct text.
				if (!rec.ended && part.text.length > rec.sent.length && part.text.startsWith(rec.sent)) {
					emit({
						type: `${kind}-delta`,
						id: key,
						delta: part.text.slice(rec.sent.length)
					} as UIMessageChunk);
					rec.sent = part.text;
				}
				if (part.state === 'done' && !rec.ended) {
					rec.ended = true;
					emit({ type: `${kind}-end`, id: key } as UIMessageChunk);
				}
				continue;
			}
			const emittedKey = `x:${key}`;
			let rec = turn.emitted.get(emittedKey);
			if (!rec) {
				rec = { started: true, sent: '', ended: false };
				turn.emitted.set(emittedKey, rec);
			}
			if (rec.ended) continue;
			// A running tool's input can change (a subagent's progress lives there),
			// so send it again whenever it does; the client updates the part in place.
			const inputJson = JSON.stringify(part.input ?? null);
			if (inputJson !== rec.sent) {
				rec.sent = inputJson;
				emit({
					type: 'tool-input-available',
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					input: part.input,
					dynamic: true
				});
			}
			if (part.state === 'output-available') {
				rec.ended = true;
				emit({
					type: 'tool-output-available',
					toolCallId: part.toolCallId,
					output: part.output,
					dynamic: true
				});
			} else if (part.state === 'output-error') {
				rec.ended = true;
				emit({
					type: 'tool-output-error',
					toolCallId: part.toolCallId,
					errorText: part.errorText ?? 'Failed',
					dynamic: true
				});
			}
		}
	}

	// ── rendering ───────────────────────────────────────────────────────

	private markDirty(runId: string | 'all' | null): void {
		if (runId === 'all') this.allRunsDirty = true;
		else if (runId) this.dirtyRuns.add(runId);
	}

	private scheduleRender(): void {
		if (this.renderTimer || this.stopped) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = null;
			try {
				this.render();
			} catch (e) {
				this.allRunsDirty = true;
				log.error('Failed to render coding task', {
					conversationId: this.conversationId,
					error: e instanceof Error ? e.message : String(e)
				});
			}
		}, RENDER_DEBOUNCE_MS);
		this.renderTimer.unref?.();
	}

	private render(): void {
		if (!this.hasSnapshot) return;
		const db = this.db;
		const conversation = getConversation(db, this.userId, this.conversationId);
		if (!conversation) {
			this.stop();
			return;
		}
		const runs = sortedRuns(this.state);
		const now = Date.now();
		let touched = false;
		let removedNotices = false;
		const allDirty = this.allRunsDirty;
		const dirty = new Set(this.dirtyRuns);
		this.allRunsDirty = false;
		this.dirtyRuns.clear();

		// Bind a pre-opened turn to its run, or open one for a run started elsewhere.
		const active = activeRun(this.state);
		if (this.live && !this.live.runId && this.live.userMessageId) {
			const run = runs.find((r) => r.userMessageId === this.live!.userMessageId);
			if (run) this.live.runId = String(run.id);
		}
		// Its run is gone (thread deleted remotely, dropped from a snapshot, evicted):
		// nothing would ever finish this turn.
		if (this.live?.runId && !this.state.runs.has(this.live.runId)) {
			this.endLive({ interrupted: true, errorText: RUN_GONE_ERROR, settleError: RUN_GONE_ERROR });
		}
		if (this.pendingInterruptFor) {
			const run = runs.find((r) => r.userMessageId === this.pendingInterruptFor);
			if (run) {
				this.pendingInterruptFor = null;
				if (isRunActive(run)) this.interruptRun(String(run.id));
			}
		}
		if (
			!this.live &&
			active &&
			String(active.id) !== this.interruptedRunId &&
			!hasActiveStream(this.conversationId) &&
			!shuttingDown
		) {
			const replyId = this.localMessageId(replyMessageId(active));
			if (!this.isForeignMessage(replyId)) this.openLive(replyId, null, String(active.id));
		}

		for (const run of runs) {
			const runId = String(run.id);
			if (!allDirty && !dirty.has(runId) && this.live?.runId !== runId) continue;
			const userMessageId = typeof run.userMessageId === 'string' ? run.userMessageId : null;
			// Mirror user messages that were sent from T3 itself, but not the notices
			// the agent's runtime sends itself (they'd read as if the user wrote them).
			const localUserMessageId = userMessageId && this.localMessageId(userMessageId);
			if (userMessageId && localUserMessageId && isAgentNotification(this.state, userMessageId)) {
				if (this.ownMessage(localUserMessageId)?.role === 'user') {
					// Mirrored before notices were told apart.
					db.prepare('DELETE FROM messages WHERE id = ? AND conversation_id = ?').run(
						localUserMessageId,
						this.conversationId
					);
					removedNotices = true;
				}
			} else if (userMessageId && localUserMessageId && !getMessage(db, localUserMessageId)) {
				const text = messageText(this.state, userMessageId);
				if (text) {
					createMessage(db, {
						id: localUserMessageId,
						conversationId: this.conversationId,
						role: 'user',
						parts: [{ type: 'text', text }],
						createdAt: Date.parse(String(run.requestedAt)) || now
					});
					touched = true;
				}
			}

			const entries = renderRun(this.state, run, this.commandOutputs);
			const parts = entries.map((e) => e.part);
			const messageId =
				this.live?.runId === runId ? this.live.messageId : this.localMessageId(replyMessageId(run));
			if (this.isForeignMessage(messageId)) continue;
			if (this.live?.runId === runId) this.emitDiff(this.live, entries);

			const finished = isRunFinished(run);
			const status = finished ? (run.status === 'failed' ? 'failed' : 'complete') : 'partial';
			const json = JSON.stringify(parts);
			const prev = this.persisted.get(messageId);
			const changed = !prev || prev.json !== json || prev.status !== status;
			const due = !prev || finished || now - prev.at >= PERSIST_INTERVAL_MS;
			if (changed && due && (parts.length > 0 || finished || this.ownMessage(messageId))) {
				const existing = this.ownMessage(messageId);
				const error = finished
					? run.status === 'completed'
						? null
						: runFailureText(this.state, run)
					: null;
				if (existing) {
					// Progress on an existing reply isn't new activity: the sidebar orders
					// by when a turn started (as for normal chats), so a running task keeps
					// its place instead of jumping up on every save.
					// A finished run whose items were partly evicted (very long threads)
					// renders incomplete: keep the parts saved while they were all known.
					const keepParts = finished && runItemsEvicted(this.state, runId);
					const partsChanged = !keepParts && existing.parts !== json;
					if (partsChanged || existing.status !== status || existing.error !== error) {
						updateMessage(db, messageId, keepParts ? { status, error } : { parts, status, error });
						// Nothing streams this reply (e.g. a background subagent still at
						// work after its turn ended), so tell an open chat to reload it.
						if (this.live?.runId !== runId) {
							publishServerEvent(this.userId, {
								type: 'chat.messages.updated',
								conversationId: this.conversationId
							});
						}
					}
				} else if (parts.length > 0 || finished) {
					createMessage(db, {
						id: messageId,
						conversationId: this.conversationId,
						role: 'assistant',
						parts,
						status,
						error,
						createdAt: (Date.parse(String(run.startedAt ?? run.requestedAt)) || now) + 1
					});
					touched = true;
				}
				this.persisted.set(messageId, { json, at: now, status });
			} else if (changed && !due) {
				this.dirtyRuns.add(runId);
				this.scheduleRender(); // flush the throttled update later
			}

			if (finished && this.live?.runId === runId) {
				// Announced before the stream finishes, as for normal chats: clients
				// read a finish without it as an error or stop (see message-queue-runner).
				if (run.status === 'completed') {
					publishServerEvent(this.userId, {
						type: 'chat.message_completed',
						conversationId: this.conversationId
					});
				}
				this.endLive({
					interrupted: run.status !== 'completed',
					errorText:
						run.status === 'failed' ? (runFailureText(this.state, run) ?? undefined) : undefined
				});
			}
		}

		if (touched && !this.quietHistory) touchConversation(db, this.conversationId);
		if (removedNotices) {
			publishServerEvent(this.userId, {
				type: 'chat.messages.updated',
				conversationId: this.conversationId
			});
		}
		this.quietHistory = false;
		this.syncSummary();
		this.syncThreadState(runs);
		this.scheduleDiffRefresh(runs);
		this.fetchMissingOutputs(runs);
	}

	// ── change size (+/-) ───────────────────────────────────────────────

	/** Re-reads the change size on the first render and whenever edits or runs finish. */
	private scheduleDiffRefresh(runs: Rec[]): void {
		let edits = 0;
		for (const item of this.state.turnItems.values()) {
			if (item.type === 'file_change' && item.status !== 'running') edits++;
		}
		const finished = runs.filter(isRunFinished).length;
		const key = `${finished}:${edits}:${String(this.state.thread?.worktreePath ?? '')}`;
		if (key === this.diffKey) return;
		this.diffKey = key;
		if (this.diffTimer) clearTimeout(this.diffTimer);
		this.diffTimer = setTimeout(() => {
			this.diffTimer = null;
			void this.refreshDiff();
		}, DIFF_DEBOUNCE_MS);
		this.diffTimer.unref?.();
	}

	private async refreshDiff(): Promise<void> {
		if (this.diffInFlight || this.stopped) return;
		this.diffInFlight = true;
		try {
			const worktree = this.state.thread?.worktreePath;
			const cwd =
				typeof worktree === 'string' && worktree ? worktree : await this.projectWorkspaceRoot();
			if (!cwd) return;
			const diff = parseDiffStat(await this.rpc('vcs.refreshStatus', { cwd, localOnly: true }));
			if (!diff) return;
			const row = getCodingConversation(this.db, this.conversationId);
			if (
				!row ||
				(row.diff_insertions === diff.insertions && row.diff_deletions === diff.deletions)
			) {
				return;
			}
			updateCodingConversation(this.db, this.conversationId, { diff });
			publishServerEvent(this.userId, {
				type: 'coding.task.updated',
				conversationId: this.conversationId
			});
		} catch (e) {
			if (!this.diffWarned) {
				this.diffWarned = true;
				log.warn('Could not read the change size of a coding task', {
					conversationId: this.conversationId,
					error: e instanceof Error ? e.message : String(e)
				});
			}
		} finally {
			this.diffInFlight = false;
		}
	}

	private async projectWorkspaceRoot(): Promise<string | null> {
		if (this.projectRoot !== undefined) return this.projectRoot;
		const row = getCodingConversation(this.db, this.conversationId);
		const body = (await t3HttpGet(
			this.env.base_url,
			decryptSecret(this.env.token_enc),
			'/api/projects'
		)) as { projects?: { id?: unknown; workspaceRoot?: unknown }[] } | null;
		const project = (Array.isArray(body?.projects) ? body.projects : []).find(
			(p) => p?.id === row?.project_id
		);
		this.projectRoot = typeof project?.workspaceRoot === 'string' ? project.workspaceRoot : null;
		return this.projectRoot;
	}

	/** Mirrors the thread's title, pinned, settled and read state (see ./thread-state.ts). */
	private syncThreadState(runs: Rec[]): void {
		const latest = runs.at(-1);
		const remote = remoteThreadState(this.state.thread, {
			completedAt:
				latest && isRunFinished(latest) ? Date.parse(String(latest.completedAt)) || null : null,
			running: activeRun(this.state) !== null
		});
		const json = JSON.stringify(remote);
		if (json === this.lastRemoteStateJson) return;
		this.lastRemoteStateJson = json;
		if (reconcileThreadState(this.db, this.userId, this.conversationId, remote)) {
			queueThreadStatePush(this.db, this.userId, [this.conversationId]);
		}
	}

	private syncSummary(): void {
		const summary = summarizeTask(this.state);
		const json = JSON.stringify(summary);
		const statusChanged = summary.status !== this.lastStatus;
		if (json !== this.lastSummaryJson) {
			this.lastSummaryJson = json;
			updateCodingConversation(this.db, this.conversationId, {
				status: summary.status,
				branch: summary.branch,
				prUrl: summary.prUrl,
				pendingRequest: summary.pendingRequest,
				runStartedAt: summary.runStartedAt,
				lastSequence: this.state.lastSequence ?? undefined,
				lastError: null
			});
			publishServerEvent(this.userId, {
				type: 'coding.task.updated',
				conversationId: this.conversationId
			});
		}
		if (statusChanged) {
			const was = this.lastStatus;
			this.lastStatus = summary.status;
			const ended =
				(was === 'running' || was === 'awaiting_input' || was === 'starting') &&
				(summary.status === 'idle' ||
					summary.status === 'failed' ||
					summary.status === 'interrupted');
			if (ended) {
				publishServerEvent(this.userId, {
					type: 'coding.thread.finished',
					conversationId: this.conversationId,
					status:
						summary.status === 'idle'
							? 'completed'
							: summary.status === 'failed'
								? 'failed'
								: 'interrupted',
					branch: summary.branch,
					prUrl: summary.prUrl
				});
			}
		}
		if (
			summary.status === 'running' ||
			summary.status === 'awaiting_input' ||
			this.live ||
			// Background subagents keep reporting after the turn that started them.
			hasRunningSubagent(this.state)
		) {
			this.cancelIdleStop();
		} else {
			this.scheduleIdleStop();
		}
	}

	/** Command and tool output is omitted from the live stream; fetch it once per item. */
	private fetchMissingOutputs(runs: Rec[]): void {
		if (!this.threadId) return;
		// Turn items are capped (see projection.ts); drop outputs of evicted ones.
		if (this.commandOutputs.size > MAX_THREAD_RECORDS) {
			for (const id of this.commandOutputs.keys()) {
				if (!this.state.turnItems.has(id)) this.commandOutputs.delete(id);
			}
		}
		for (const id of this.failedOutputs.keys()) {
			if (!this.state.turnItems.has(id)) this.failedOutputs.delete(id);
		}
		const now = Date.now();
		const recent = new Set(runs.slice(-OUTPUT_FETCH_RUNS).map((r) => String(r.id)));
		for (const item of this.state.turnItems.values()) {
			const id = String(item.id);
			if (
				(item.type !== 'command_execution' && item.type !== 'dynamic_tool') ||
				item.outputOmitted !== true ||
				!recent.has(String(item.runId)) ||
				(item.status !== 'completed' && item.status !== 'failed') ||
				this.commandOutputs.has(id) ||
				this.fetchingOutputs.has(id)
			) {
				continue;
			}
			// A failed fetch is retried on a later render, spaced out and a few times only.
			const failed = this.failedOutputs.get(id);
			if (failed && (failed.attempts >= MAX_OUTPUT_ATTEMPTS || now - failed.at < OUTPUT_RETRY_MS)) {
				continue;
			}
			this.fetchingOutputs.add(id);
			this.rpc('orchestration.getTurnItem', { threadId: this.threadId, itemId: id })
				.then((result) => {
					const output = (result as { item?: { output?: unknown } } | null)?.item?.output;
					const text =
						typeof output === 'string'
							? output
							: output === undefined
								? ''
								: JSON.stringify(output, null, 2);
					this.commandOutputs.set(
						id,
						text.length > MAX_OUTPUT_CHARS
							? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)`
							: text
					);
					this.failedOutputs.delete(id);
					this.markDirty(String(item.runId));
					this.scheduleRender();
				})
				.catch(() => {
					this.failedOutputs.set(id, {
						at: Date.now(),
						attempts: (this.failedOutputs.get(id)?.attempts ?? 0) + 1
					});
				})
				.finally(() => this.fetchingOutputs.delete(id));
		}
	}

	private scheduleIdleStop(): void {
		if (this.idleTimer || this.stopped) return;
		this.idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS);
		this.idleTimer.unref?.();
	}

	private cancelIdleStop(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}
}

// ── registry ─────────────────────────────────────────────────────────────

export function getFollower(conversationId: string): CodingFollower | undefined {
	return followers.get(conversationId);
}

export function ensureFollower(input: {
	conversationId: string;
	userId: string;
	env: CodingEnvironmentRow;
	threadId: string | null;
	/** See {@link CodingFollower.quietHistory}; only applies to a new follower. */
	quietHistory?: boolean;
}): CodingFollower {
	const existing = followers.get(input.conversationId);
	if (existing) {
		existing.updateEnvironment(input.env);
		return existing;
	}
	const follower = new CodingFollower(
		input.conversationId,
		input.userId,
		input.env,
		input.threadId,
		getDb(),
		{ quietHistory: input.quietHistory }
	);
	followers.set(input.conversationId, follower);
	return follower;
}

/** Call before shutdown aborts streams: remote runs must keep going. */
export function prepareCodingShutdown(): void {
	shuttingDown = true;
}

/**
 * Stops followers of an environment that was deleted, disabled or re-pointed,
 * so they don't keep using the old URL and token. Still-relevant ones are
 * re-created on demand (thread sync, next turn) with the current row.
 */
export function stopFollowersForEnvironment(environmentId: string, reason?: string): void {
	for (const follower of [...followers.values()]) {
		if (follower.environmentId === environmentId) follower.stop(reason);
	}
}

export function stopAllCodingFollowers(): void {
	for (const follower of [...followers.values()]) follower.stop();
}
