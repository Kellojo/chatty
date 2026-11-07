// Follows one coding task's T3 Code thread and mirrors it into Chatty:
// - live: the active run streams into the chat stream registry as UI message
//   chunks, so the normal chat UI (resume, Stop, sidebar spinner) just works;
// - persisted: every run's reply is written as an assistant message;
// - task state (status, branch, PR, pending approval/question) goes to
//   `coding_conversations` and is announced with `coding.task.updated`.
//
// One follower per conversation, kept alive while the task is active and for a
// grace period after it goes idle. It reconnects with backoff if the socket drops.

import { randomUUID } from 'node:crypto';
import type { UIMessageChunk } from 'ai';
import {
	appendChunk,
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
import {
	getConversation,
	setConversationTitle,
	touchConversation
} from '../db/repo/conversations.js';
import { createMessage, getMessage, updateMessage } from '../db/repo/messages.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { connectT3, T3ClientError, type T3Connection, type T3Stream } from './client.js';
import {
	activeRun,
	applyStreamItem,
	emptyThreadState,
	isRunActive,
	isRunFinished,
	messageText,
	renderRun,
	replyMessageId,
	runFailureText,
	sortedRuns,
	summarizeTask,
	type RenderedEntry,
	type ThreadState
} from './projection.js';

const log = createLogger('t3-follower');

const RENDER_DEBOUNCE_MS = 120;
const PERSIST_INTERVAL_MS = 1000;
const IDLE_STOP_MS = 5 * 60 * 1000;
const MAX_RECONNECT_MS = 60_000;
const MAX_OUTPUT_CHARS = 16_000;
/** Only fetch omitted command output for the most recent runs. */
const OUTPUT_FETCH_RUNS = 3;

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
}

let shuttingDown = false;
const followers = new Map<string, CodingFollower>();

export class CodingFollower {
	private state: ThreadState = emptyThreadState();
	private conn: T3Connection | null = null;
	private connecting: Promise<T3Connection> | null = null;
	private stream: T3Stream | null = null;
	private stopped = false;
	private reconnectDelay = 2000;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private renderTimer: ReturnType<typeof setTimeout> | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private live: LiveTurn | null = null;
	private readonly persisted = new Map<string, { json: string; at: number; status: string }>();
	private readonly commandOutputs = new Map<string, string>();
	private readonly fetchingOutputs = new Set<string>();
	private lastSummaryJson = '';
	private lastStatus: string | null = null;
	private hasSnapshot = false;

	constructor(
		readonly conversationId: string,
		readonly userId: string,
		private env: CodingEnvironmentRow,
		private threadId: string | null,
		private readonly db: Db = getDb()
	) {
		const row = getCodingConversation(db, conversationId);
		this.lastStatus = row?.status ?? null;
	}

	// ── connection ──────────────────────────────────────────────────────

	/** Opens (or reuses) the socket. Commands and the subscription share it. */
	private connection(): Promise<T3Connection> {
		if (this.conn && !this.conn.closed) return Promise.resolve(this.conn);
		this.connecting ??= connectT3(this.env.base_url, decryptSecret(this.env.token_enc))
			.then((conn) => {
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
		if (this.stopped || !this.threadId || this.stream) return;
		this.cancelIdleStop();
		try {
			const conn = await this.connection();
			if (this.stream || this.stopped) return;
			this.stream = conn.stream(
				'orchestration.subscribeThread',
				{ threadId: this.threadId },
				{
					onValue: (value) => {
						if (applyStreamItem(this.state, value)) {
							if ((value as Rec)?.kind === 'snapshot') this.hasSnapshot = true;
							this.reconnectDelay = 2000;
							this.scheduleRender();
						}
					},
					onEnd: (error) => {
						this.stream = null;
						if (error) this.recordError(error);
						this.scheduleReconnect();
					}
				}
			);
		} catch (e) {
			this.recordError(e);
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer || !this.threadId) return;
		const delay = this.reconnectDelay;
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.follow();
		}, delay);
		this.reconnectTimer.unref?.();
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

	stop(): void {
		this.stopped = true;
		this.cancelIdleStop();
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.renderTimer) clearTimeout(this.renderTimer);
		this.stream?.cancel();
		this.stream = null;
		this.conn?.close();
		this.conn = null;
		if (followers.get(this.conversationId) === this) followers.delete(this.conversationId);
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

	private interruptRun(runId: string): void {
		if (!this.threadId) return;
		this.rpc('orchestration.dispatchCommand', {
			type: 'run.interrupt',
			commandId: randomUUID(),
			threadId: this.threadId,
			runId,
			holdQueue: true
		}).catch((e) => this.recordError(e));
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
		this.openLive(`${userMessageId}:reply`, userMessageId, null);
	}

	/** Ends a turn that never started remotely (e.g. launch failed). */
	failTurn(): void {
		const live = this.live;
		if (!live || live.runId) return;
		this.endLive({ interrupted: false });
		const row = getMessage(this.db, live.messageId);
		if (row && row.parts === '[]') {
			this.db.prepare('DELETE FROM messages WHERE id = ?').run(live.messageId);
		}
	}

	private openLive(messageId: string, userMessageId: string | null, runId: string | null): void {
		const controller = new AbortController();
		registerStream(this.conversationId, controller);
		const turn: LiveTurn = {
			controller,
			messageId,
			userMessageId,
			runId,
			interruptWhenBound: false,
			emitted: new Map()
		};
		this.live = turn;
		if (!getMessage(this.db, messageId)) {
			createMessage(this.db, {
				id: messageId,
				conversationId: this.conversationId,
				role: 'assistant',
				parts: [],
				status: 'partial'
			});
		} else {
			updateMessage(this.db, messageId, { status: 'partial', error: null });
		}
		appendChunk(this.conversationId, { type: 'start', messageId }, controller);
		publishServerEvent(this.userId, {
			type: 'chat.stream.started',
			conversationId: this.conversationId
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

	private endLive(opts: {
		interrupted: boolean;
		errorText?: string;
		keepPendingInterrupt?: boolean;
	}): void {
		const turn = this.live;
		if (!turn) return;
		this.live = null;
		if (opts.keepPendingInterrupt && turn.userMessageId) {
			this.pendingInterruptFor = turn.userMessageId;
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
				if (part.text.length > rec.sent.length && part.text.startsWith(rec.sent)) {
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
				emit({
					type: 'tool-input-available',
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					input: part.input,
					dynamic: true
				});
			}
			if (rec.ended) continue;
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

	private scheduleRender(): void {
		if (this.renderTimer || this.stopped) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = null;
			try {
				this.render();
			} catch (e) {
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

		// Bind a pre-opened turn to its run, or open one for a run started elsewhere.
		const active = activeRun(this.state);
		if (this.live && !this.live.runId && this.live.userMessageId) {
			const run = runs.find((r) => r.userMessageId === this.live!.userMessageId);
			if (run) this.live.runId = String(run.id);
		}
		if (this.pendingInterruptFor) {
			const run = runs.find((r) => r.userMessageId === this.pendingInterruptFor);
			if (run) {
				this.pendingInterruptFor = null;
				if (isRunActive(run)) this.interruptRun(String(run.id));
			}
		}
		if (!this.live && active && !hasActiveStream(this.conversationId) && !shuttingDown) {
			this.openLive(replyMessageId(active), null, String(active.id));
		}

		for (const run of runs) {
			const runId = String(run.id);
			const userMessageId = typeof run.userMessageId === 'string' ? run.userMessageId : null;
			// Mirror user messages that were sent from T3 itself.
			if (userMessageId && !getMessage(db, userMessageId)) {
				const text = messageText(this.state, userMessageId);
				if (text) {
					createMessage(db, {
						id: userMessageId,
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
			const messageId = this.live?.runId === runId ? this.live.messageId : replyMessageId(run);
			if (this.live?.runId === runId) this.emitDiff(this.live, entries);

			const finished = isRunFinished(run);
			const status = finished ? (run.status === 'failed' ? 'failed' : 'complete') : 'partial';
			const json = JSON.stringify(parts);
			const prev = this.persisted.get(messageId);
			const changed = !prev || prev.json !== json || prev.status !== status;
			const due = !prev || finished || now - prev.at >= PERSIST_INTERVAL_MS;
			if (changed && due && (parts.length > 0 || finished || getMessage(db, messageId))) {
				const existing = getMessage(db, messageId);
				const error = finished
					? run.status === 'completed'
						? null
						: runFailureText(this.state, run)
					: null;
				if (existing) {
					if (existing.parts !== json || existing.status !== status || existing.error !== error) {
						updateMessage(db, messageId, { parts, status, error });
						touched = true;
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
				this.scheduleRender(); // flush the throttled update later
			}

			if (finished && this.live?.runId === runId) {
				this.endLive({
					interrupted: run.status !== 'completed',
					errorText:
						run.status === 'failed' ? (runFailureText(this.state, run) ?? undefined) : undefined
				});
				if (run.status === 'completed') {
					publishServerEvent(this.userId, {
						type: 'chat.message_completed',
						conversationId: this.conversationId
					});
				}
			}
		}

		if (touched) touchConversation(db, this.conversationId);
		this.syncSummary(conversation.title);
		this.fetchMissingOutputs(runs);
	}

	private syncSummary(conversationTitle: string): void {
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
				lastSequence: this.state.lastSequence ?? undefined,
				lastError: null
			});
			// Adopt T3's generated title while ours is still the provisional one.
			if (summary.title && summary.title !== conversationTitle && conversationTitle.length <= 51) {
				setConversationTitle(this.db, this.conversationId, summary.title);
				publishServerEvent(this.userId, {
					type: 'conversation.updated',
					conversationId: this.conversationId
				});
			}
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
		if (summary.status === 'running' || summary.status === 'awaiting_input' || this.live) {
			this.cancelIdleStop();
		} else {
			this.scheduleIdleStop();
		}
	}

	/** Command output is omitted from the live stream; fetch it once per command. */
	private fetchMissingOutputs(runs: Rec[]): void {
		if (!this.threadId) return;
		const recent = new Set(runs.slice(-OUTPUT_FETCH_RUNS).map((r) => String(r.id)));
		for (const item of this.state.turnItems.values()) {
			const id = String(item.id);
			if (
				item.type !== 'command_execution' ||
				item.outputOmitted !== true ||
				!recent.has(String(item.runId)) ||
				(item.status !== 'completed' && item.status !== 'failed') ||
				this.commandOutputs.has(id) ||
				this.fetchingOutputs.has(id)
			) {
				continue;
			}
			this.fetchingOutputs.add(id);
			this.rpc('orchestration.getTurnItem', { threadId: this.threadId, itemId: id })
				.then((result) => {
					const output = (result as { item?: { output?: unknown } } | null)?.item?.output;
					const text = typeof output === 'string' ? output : '';
					this.commandOutputs.set(
						id,
						text.length > MAX_OUTPUT_CHARS
							? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)`
							: text
					);
					this.scheduleRender();
				})
				.catch(() => this.commandOutputs.set(id, ''))
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
		input.threadId
	);
	followers.set(input.conversationId, follower);
	return follower;
}

/** Call before shutdown aborts streams: remote runs must keep going. */
export function prepareCodingShutdown(): void {
	shuttingDown = true;
}

export function stopAllCodingFollowers(): void {
	for (const follower of [...followers.values()]) follower.stop();
}
