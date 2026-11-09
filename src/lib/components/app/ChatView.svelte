<script lang="ts">
	import { Chat } from '@ai-sdk/svelte';
	import { DefaultChatTransport } from 'ai';
	import { onMount, tick, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { toast } from 'svelte-sonner';
	import {
		ChatContainer,
		ChatContainerContent,
		type ChatContainerContext
	} from '$lib/components/ai/chat-container/index.js';
	import {
		PromptInput,
		PromptInputTextarea,
		PromptInputActions
	} from '$lib/components/ai/prompt-input/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import SquareIcon from '@lucide/svelte/icons/square';
	import ListEndIcon from '@lucide/svelte/icons/list-end';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import FileIcon from '@lucide/svelte/icons/file';
	import XIcon from '@lucide/svelte/icons/x';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import LoaderIcon from '@lucide/svelte/icons/loader-circle';
	import ChatTopbar from './ChatTopbar.svelte';
	import CodingPendingRequest from './CodingPendingRequest.svelte';
	import MessageTimeline from './MessageTimeline.svelte';
	import { hasVisibleContent } from './timeline.js';
	import ThinkingIndicator from './ThinkingIndicator.svelte';
	import { activeChats } from '$lib/state/active-chats.svelte.js';
	import {
		canCreatePullRequest,
		createPullRequestPrompt,
		type CodingRecoveryAction
	} from '$lib/coding-task-details.js';
	import { onServerEvent, onServerEventResync } from '$lib/state/events.svelte.js';
	import { invalidateWhenIdle } from '$lib/state/invalidate-when-idle.js';
	import { CONVERSATIONS_KEY } from '$lib/load-keys.js';
	import { drafts } from '$lib/state/drafts.js';
	import { registerChatShortcuts, shortcutLabel } from '$lib/state/shortcuts.js';
	import {
		messageFiles,
		messageText,
		prependOlder,
		reuseUnchanged,
		withLatestPage
	} from '$lib/chat-history.js';
	import { pendingMessage } from '$lib/state/pending-message.svelte.js';
	import { messageQueue, type QueuedMessage } from '$lib/state/message-queue.svelte.js';
	import QueuedMessages from './QueuedMessages.svelte';
	import { parseSkillCommand, uploadAttachments } from '$lib/chat-send.js';
	import { createFileDrop } from '$lib/state/file-drop.svelte.js';
	import PendingAttachments from './PendingAttachments.svelte';
	import { clipboardFiles } from '$lib/state/clipboard-files.js';
	import MicButton from '$lib/components/app/MicButton.svelte';
	import { createSpeechRecognition } from '$lib/state/speech-recognition.svelte.js';
	import { createServerSpeechRecognition } from '$lib/state/server-speech-recognition.svelte.js';
	import {
		chatMessageToUIMessage,
		type Agent,
		type ChatMessage,
		type Conversation,
		type ModelMapping,
		type ModelsByProvider,
		type UIMessage,
		type UIMessageMetadata
	} from '$lib/types.js';
	import type { TimeFormat } from '$lib/user-settings.js';
	import type { CodingConversation, CodingEnvironment } from '$lib/coding-environments.js';
	import { browserActivity } from '$lib/coding-preview.js';

	let {
		conversation: initialConversation,
		initialMessages,
		hasOlderMessages = false,
		groups,
		mappings = [],
		defaultModel,
		timeFormat = 'auto',
		personas,
		sttModel = null,
		initiallyGenerating = false,
		coding: initialCoding = null,
		codingEnvironments = [],
		codingAgents = []
	}: {
		conversation: Conversation;
		/** The newest page of messages; earlier ones load on scroll. */
		initialMessages: ChatMessage[];
		/** Messages exist before `initialMessages`. */
		hasOlderMessages?: boolean;
		groups: ModelsByProvider[];
		mappings?: ModelMapping[];
		defaultModel?: { providerId: string; modelId: string } | null;
		sttModel?: { providerId: string; modelId: string } | null;
		timeFormat?: TimeFormat;
		personas?: Agent[];
		initiallyGenerating?: boolean;
		/** Set when this conversation is a coding task run by a remote agent. */
		coding?: CodingConversation | null;
		/** Targets for handing this chat off to a coding agent. */
		codingEnvironments?: CodingEnvironment[];
		codingAgents?: Agent[];
	} = $props();

	// Local edits apply immediately; reloaded page data (e.g. a task settled or
	// renamed on T3) replaces them.
	let conversation = $derived(initialConversation);
	// The unsent text survives switching chats (this view remounts per chat).
	let input = $state(drafts.get(untrack(() => initialConversation.id)));
	const speech = sttModel ? createServerSpeechRecognition(sttModel) : createSpeechRecognition();
	let selectedFiles = $state<File[]>([]);
	let fileInput: HTMLInputElement | undefined = $state();

	const displayInput = $derived(speech.recording ? (input + ' ' + speech.display).trim() : input);

	$effect(() => {
		if (!speech.recording && speech.finalTranscript) {
			input = (input + ' ' + speech.finalTranscript).trim();
			speech.reset();
		}
	});

	$effect(() => () => speech.destroy());

	function createChat(): Chat<UIMessage> {
		return new Chat({
			id: untrack(() => conversation.id),
			messages: untrack(() => initialMessages.map(chatMessageToUIMessage)),
			transport: new DefaultChatTransport({
				api: '/api/chat',
				prepareSendMessagesRequest: ({ messages, trigger, messageId }) => {
					if (trigger === 'regenerate-message' && messageId) {
						// the SDK has already sliced the assistant message off; the last
						// remaining message is the user message to regenerate from. The
						// server keeps the old reply as another version of the new one.
						const message = messages[messages.length - 1];
						return {
							body: { conversationId: conversation.id, message, branchFrom: messageId }
						};
					}
					const message = messages[messages.length - 1];
					const branchFrom = pendingBranchFrom;
					pendingBranchFrom = undefined;
					return {
						body: {
							conversationId: conversation.id,
							message,
							...(branchFrom ? { branchFrom } : {})
						}
					};
				},
				prepareReconnectToStreamRequest: () => ({
					api: `/api/chat/${conversation.id}/stream`
				})
			}),
			onError: (error) => {
				// Another tab's newer message took over; this tab follows that reply.
				if (isSuperseded(error)) return;
				toast.error(errorText(error) || 'Something went wrong');
			}
		});
	}

	const SUPERSEDED_MESSAGE = 'Superseded by a newer message';

	/**
	 * The readable text of a chat request error. The transport throws the raw
	 * response body, which for server errors is JSON: `{"message": "..."}`.
	 */
	function errorText(error: Error | undefined): string {
		if (!error?.message) return '';
		try {
			const message = (JSON.parse(error.message) as { message?: unknown }).message;
			if (typeof message === 'string') return message;
		} catch {
			// Not JSON: already readable text.
		}
		return error.message;
	}

	/** The server's 409 for a request a newer one for this conversation replaced. */
	function isSuperseded(error: Error | undefined): boolean {
		return errorText(error) === SUPERSEDED_MESSAGE;
	}

	function initChat(): Chat<UIMessage> {
		const id = untrack(() => conversation.id);
		const existing = activeChats.get(id);
		if (existing && (existing.status === 'submitted' || existing.status === 'streaming')) {
			return existing;
		}
		if (existing) activeChats.delete(id);
		return createChat();
	}

	// ── coding task ──────────────────────────────────────────────────────────
	// svelte-ignore state_referenced_locally
	let coding = $state(initialCoding);
	let codingEnvironmentName = $state<string | null>(null);
	// The remote agent can't rewind or read attachments, so hide those affordances.
	const isCoding = $derived(coding !== null);

	// Only the most recently started refresh may apply, so a slow stale response
	// can't restore an old status or a cleared pending request.
	let codingRefreshSeq = 0;
	async function refreshCoding() {
		const seq = ++codingRefreshSeq;
		const res = await fetch(`/api/coding/tasks/${encodeURIComponent(conversation.id)}`);
		if (!res.ok || seq !== codingRefreshSeq) return;
		const data = (await res.json()) as { coding: CodingConversation };
		if (seq === codingRefreshSeq) coding = data.coding;
	}

	// Page data reloads (invalidate) carry task state too, but a load can resolve
	// after a newer fetched snapshot. Take it as-is only when nothing is known yet
	// (e.g. a hand-off just made this a coding task); otherwise re-read through
	// the sequenced refresh.
	// svelte-ignore state_referenced_locally
	let seenInitialCoding = initialCoding;
	$effect(() => {
		const next = initialCoding;
		if (!next || next === seenInitialCoding) return;
		seenInitialCoding = next;
		untrack(() => {
			if (coding === null) coding = next;
			else void refreshCoding().catch(() => undefined);
		});
	});

	$effect(() => {
		if (!isCoding) return;
		const id = conversation.id;
		const refresh = () => void refreshCoding().catch(() => undefined);
		const offEvent = onServerEvent((event) => {
			if (
				(event.type === 'coding.task.updated' || event.type === 'coding.thread.finished') &&
				event.conversationId === id
			) {
				refresh();
			}
		});
		const offResync = onServerEventResync(refresh);
		return () => {
			offEvent();
			offResync();
		};
	});

	const codingEnvironmentId = $derived(coding?.environmentId ?? null);
	$effect(() => {
		const environmentId = codingEnvironmentId;
		if (!environmentId) return;
		let cancelled = false;
		void fetch('/api/coding/options')
			.then((res) => (res.ok ? res.json() : null))
			.then((data: { environments?: CodingEnvironment[] } | null) => {
				if (cancelled) return;
				codingEnvironmentName =
					data?.environments?.find((e) => e.id === environmentId)?.name ?? null;
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	});

	let chat = $state(initChat());
	/** The message the next send is a new version of (an edit). */
	let pendingBranchFrom = $state<string | undefined>(undefined);
	// svelte-ignore state_referenced_locally
	let hasOlder = $state(hasOlderMessages);

	const reusedLocal = activeChats.has(untrack(() => conversation.id));
	// svelte-ignore state_referenced_locally
	let remoteGenerating = $state(initiallyGenerating && !reusedLocal);

	let prevStatus: string = chat.status;

	// svelte-ignore state_referenced_locally
	const messageTimes = new SvelteMap<string, number>(
		initialMessages.map((m) => [m.id, m.createdAt])
	);

	function recordTimes(list: ChatMessage[]) {
		for (const m of list) messageTimes.set(m.id, m.createdAt);
	}

	/** Shows the reloaded newest page of messages, keeping earlier pages already loaded. */
	function showLatest() {
		recordTimes(initialMessages);
		const latest = withLatestPage(chat.messages, initialMessages.map(chatMessageToUIMessage));
		if (!latest.keptOlder) hasOlder = hasOlderMessages;
		// Unchanged messages keep their objects, so the timeline only re-renders
		// what actually changed (background updates arrive often on long tasks).
		chat.messages = reuseUnchanged(chat.messages, latest.messages);
	}

	const streaming = $derived(
		chat.status === 'streaming' || chat.status === 'submitted' || remoteGenerating
	);
	const lastAssistant = $derived(chat.messages.findLast((m) => m.role === 'assistant'));
	/** The coding agent's browser use in the run in progress, for the preview's picture-in-picture. */
	const codingBrowserActivity = $derived(
		coding && (coding.status === 'running' || coding.status === 'starting') && lastAssistant
			? browserActivity(lastAssistant.parts, String(coding.runStartedAt ?? lastAssistant.id))
			: null
	);
	// A coding agent blocked on a question keeps its reply stream open, but it's
	// waiting on you, not working: the pending request card says so instead.
	const waiting = $derived(
		!coding?.pendingRequest &&
			(remoteGenerating ||
				chat.status === 'submitted' ||
				(chat.status === 'streaming' &&
					(!lastAssistant || !hasVisibleContent(lastAssistant.parts))))
	);

	// When the current wait began: the coding run's own start if known, else when
	// this view started waiting.
	let waitStartedLocally = $state<number | null>(null);
	$effect(() => {
		if (!waiting) waitStartedLocally = null;
		else if (waitStartedLocally === null) waitStartedLocally = Date.now();
	});
	const waitingSince = $derived(waiting ? (coding?.runStartedAt ?? waitStartedLocally) : null);
	const hasContent = $derived(displayInput.trim().length > 0 || selectedFiles.length > 0);

	let scroll = $state<ChatContainerContext>();
	const showJumpToLatest = $derived(scroll !== undefined && !scroll.isAtBottom);

	// The log is aria-busy while a reply streams, so screen readers don't read
	// every token; announce when it starts and once when it's done instead.
	let replyAnnouncement = $state('');
	let wasStreaming = false;
	$effect(() => {
		const now = streaming;
		if (now && !wasStreaming) replyAnnouncement = 'Thinking';
		else if (wasStreaming && chat.status !== 'error') replyAnnouncement = 'Response complete';
		wasStreaming = now;
	});
	let sending = $state(false);

	async function markRead() {
		await fetch(`/api/conversations/${conversation.id}/read`, { method: 'POST' }).catch(
			() => undefined
		);
		// Only the sidebar's unread markers change; the page itself is current.
		await invalidateWhenIdle(CONVERSATIONS_KEY);
	}

	const localBusy = () => chat.status === 'streaming' || chat.status === 'submitted' || sending;

	/**
	 * A stream is (or was) running server-side. Attach to it for live tokens;
	 * a 204 means it already finished, so just reload the persisted state.
	 */
	function resumeRemoteStream() {
		chat
			.resumeStream()
			.catch(() => undefined)
			.finally(() => {
				if (chat.status !== 'streaming' && chat.status !== 'submitted') {
					remoteGenerating = false;
					void invalidateWhenIdle();
				}
			});
	}

	onMount(() => {
		if (remoteGenerating) resumeRemoteStream();
		else markRead();
	});

	// A reply started elsewhere while this view is open (another tab, a turn
	// started on T3). Streams this tab started itself are already attached.
	$effect(() => {
		const id = conversation.id;
		return onServerEvent((event) => {
			if (event.type !== 'chat.stream.started' || event.conversationId !== id) return;
			if (remoteGenerating || localBusy()) return;
			void followRemoteStream(id);
		});
	});

	/** Attaches to a reply running server-side that this view didn't start. */
	async function followRemoteStream(id: string) {
		remoteGenerating = true;
		// Pick up the user message that started the turn before attaching.
		await invalidateWhenIdle();
		await tick();
		if (!remoteGenerating || localBusy() || conversation.id !== id) return;
		showLatest();
		resumeRemoteStream();
	}

	$effect(() => {
		const pending = pendingMessage.consume(conversation.id);
		if (!pending) return;
		untrack(() => {
			if (pending.files.length > 0) addFiles(pending.files);
			void send(pending.text);
		});
	});

	$effect(() => {
		for (const m of chat.messages) {
			if (!messageTimes.has(m.id)) messageTimes.set(m.id, Date.now());
		}
	});

	$effect(() => {
		if (!remoteGenerating) return;
		const id = conversation.id;
		let finishing = false;
		const finish = async () => {
			if (finishing || !remoteGenerating) return;
			finishing = true;
			remoteGenerating = false;
			await invalidateWhenIdle();
			await tick();
			// A queued message may already be on its way; don't wipe it.
			if (chat.status === 'streaming' || chat.status === 'submitted') return;
			showLatest();
			await markRead();
		};
		const offEvent = onServerEvent((event) => {
			if (event.type === 'chat.stream.finished' && event.conversationId === id) {
				void finish();
			}
		});
		const offResync = onServerEventResync(() => {
			void (async () => {
				const res = await fetch('/api/chat/active');
				if (!res.ok) return;
				const { conversationIds } = (await res.json()) as { conversationIds: string[] };
				if (!conversationIds.includes(id)) await finish();
			})().catch(() => {});
		});
		return () => {
			offEvent();
			offResync();
		};
	});

	// Replies can change with no stream attached (a coding task's background
	// subagent reporting progress after its turn ended); reload them while idle.
	$effect(() => {
		if (!isCoding) return;
		const id = conversation.id;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const reload = async () => {
			timer = null;
			if (streaming || conversation.id !== id) return;
			await invalidateWhenIdle();
			await tick();
			if (streaming || conversation.id !== id) return;
			showLatest();
		};
		const off = onServerEvent((event) => {
			if (event.type !== 'chat.messages.updated' || event.conversationId !== id) return;
			timer ??= setTimeout(() => void reload(), 300);
		});
		return () => {
			off();
			if (timer) clearTimeout(timer);
		};
	});

	/**
	 * After a failed stream, reload the persisted messages so the failed response
	 * (with its error) shows inline instead of only in a toast. The server persists
	 * it just before announcing `chat.stream.finished`, so wait for that first.
	 */
	async function reloadAfterError(id: string) {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(done, 10_000);
			const off = onServerEvent((event) => {
				if (event.type === 'chat.stream.finished' && event.conversationId === id) done();
			});
			function done() {
				clearTimeout(timer);
				off();
				resolve();
			}
			fetch('/api/chat/active')
				.then((res) => (res.ok ? res.json() : null))
				.then((data: { conversationIds: string[] } | null) => {
					if (data && !data.conversationIds.includes(id)) done();
				})
				.catch(() => {});
		});
		if (conversation.id !== id || chat.status !== 'error') return;
		await invalidateWhenIdle();
		await tick();
		if (conversation.id !== id || chat.status !== 'error') return;
		showLatest();
	}

	$effect(() => {
		const current = chat.status;
		if (prevStatus !== 'error' && current === 'error') {
			const id = conversation.id;
			const superseded = isSuperseded(chat.error);
			untrack(() => {
				// A newer message (likely from another tab) took over: follow its
				// reply, which may have started before this request failed.
				if (superseded) {
					if (!remoteGenerating) void followRemoteStream(id);
					return;
				}
				messageQueue.pause(id);
				void reloadAfterError(id);
			});
		}
		if (prevStatus !== 'ready' && current === 'ready') {
			markRead();
			if (activeChats.get(conversation.id) === chat) {
				activeChats.delete(conversation.id);
			}
		}
		prevStatus = current;
	});

	const INTERRUPT_TIMEOUT_MS = 2000;

	// ── queue ────────────────────────────────────────────────────────────────
	// Messages written while a reply runs wait here and go out one by one once
	// the chat is idle. "Send now" interrupts the reply instead.
	const queue = $derived(messageQueue.list(conversation.id));
	const queuePaused = $derived(messageQueue.isPaused(conversation.id));

	/** Sends the composer's message, or queues it while the chat is busy. */
	async function send(text: string) {
		speech.stop();
		speech.reset();
		const trimmed = text.trim();
		if (editing) {
			if (!trimmed && selectedFiles.length === 0 && editing.keptFiles.length === 0) return;
			// An edit starts a new branch from the edited message, so it never waits in the queue.
			const edit = { messageId: editing.messageId, keptFiles: editing.keptFiles };
			if (await deliver(trimmed, selectedFiles, edit)) {
				editing = null;
				input = '';
				clearFiles();
			}
			return;
		}
		if (!trimmed && selectedFiles.length === 0) return;
		// Behind earlier queued messages unless the queue waits for the user.
		if (streaming || sending || (queue.length > 0 && !queuePaused)) {
			messageQueue.add(conversation.id, { text: trimmed, files: selectedFiles });
			input = '';
			clearFiles();
			return;
		}
		messageQueue.resume(conversation.id);
		if (await deliver(trimmed, selectedFiles)) {
			input = '';
			clearFiles();
		}
	}

	/**
	 * Interrupts any running reply and sends the message. With `edit`, the
	 * message is a new version of that one: it and everything after it make way
	 * for the new branch (the server keeps them as the older version), and the
	 * edited message's attachments that were kept are sent along as they are.
	 * Returns false on failure.
	 */
	async function deliver(
		text: string,
		files: File[],
		edit?: { messageId: string; keptFiles: FilePart[] }
	): Promise<boolean> {
		if (sending) return false;
		sending = true;
		const { text: trimmed, skill } = parseSkillCommand(text);
		try {
			const body = skill ? { body: { skill } } : undefined;
			// Upload first: if this fails the running response is left untouched.
			const fileParts = files.length > 0 ? await uploadAttachments(conversation.id, files) : [];
			await interruptResponse();
			if (edit) {
				const index = chat.messages.findIndex((m) => m.id === edit.messageId);
				if (index === -1) throw new Error('The edited message is no longer in this chat');
				const original = chat.messages[index];
				chat.messages = chat.messages.slice(0, index);
				pendingBranchFrom = edit.messageId;
				const id = crypto.randomUUID();
				const versions = (original.metadata as UIMessageMetadata | undefined)?.branch?.ids ?? [
					original.id
				];
				const ids = [...versions, id];
				chat.sendMessage(
					{
						id,
						parts: [
							...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []),
							...edit.keptFiles,
							...fileParts
						],
						metadata: { branch: { ids, index: ids.length - 1, count: ids.length } }
					},
					body
				);
			} else if (fileParts.length > 0) {
				chat.sendMessage(
					{
						parts: [...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []), ...fileParts]
					},
					body
				);
			} else {
				chat.sendMessage({ text: trimmed }, body);
			}
			activeChats.set(conversation.id, chat);
			return true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to send message');
			return false;
		} finally {
			sending = false;
		}
	}

	/** Sends a queued message; on failure it goes back to the front, paused. */
	async function deliverQueued(item: QueuedMessage) {
		const id = conversation.id;
		if (!messageQueue.remove(id, item.id)) return;
		if (!(await deliver(item.text, item.files))) {
			messageQueue.prepend(id, item);
			messageQueue.pause(id);
		}
	}

	function sendQueuedNow(item: QueuedMessage) {
		if (sending) return;
		messageQueue.resume(conversation.id);
		void deliverQueued(item);
	}

	function editQueued(item: QueuedMessage) {
		if (!messageQueue.remove(conversation.id, item.id)) return;
		input = input.trim() ? `${input.trimEnd()}\n${item.text}` : item.text;
		if (item.files.length > 0) addFiles(item.files);
	}

	// While open, this view sends the queue itself (see message-queue-runner).
	onMount(() => messageQueue.attach(untrack(() => conversation.id)));

	// Drain: the next queued message goes out as soon as the chat is idle.
	$effect(() => {
		const next = queue[0];
		if (!next || streaming || sending || queuePaused || coding?.pendingRequest) return;
		untrack(() => void deliverQueued(next));
	});

	// Stops the response being received so a new message can take over. The Chat
	// can't start a request until the aborted one has settled. The server aborts
	// its side when the new message arrives; calling the abort endpoint here could
	// reach it after that message and kill the new response instead.
	async function interruptResponse() {
		remoteGenerating = false;
		await chat.stop();
		const deadline = Date.now() + INTERRUPT_TIMEOUT_MS;
		while ((chat.status === 'streaming' || chat.status === 'submitted') && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
		}
	}

	async function stop() {
		// Stopping means "wait for me": don't fire the next queued message.
		messageQueue.pause(conversation.id);
		fetch(`/api/chat/${conversation.id}/abort`, { method: 'POST' }).catch(() => undefined);
		await chat.stop();
	}

	/** Sends a predefined message to the coding agent without touching the draft. */
	async function sendCodingFollowUp(message: { text: string } | { parts: UIMessage['parts'] }) {
		// The task's status only changes once the agent picks the message up, so
		// its button stays clickable meanwhile: a second click must not send again.
		if (!coding || localBusy()) return;
		sending = true;
		try {
			await interruptResponse();
			chat.sendMessage(message);
			activeChats.set(conversation.id, chat);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to send message');
		} finally {
			sending = false;
		}
	}

	function createPullRequest() {
		if (coding && canCreatePullRequest(coding)) {
			void sendCodingFollowUp({ text: createPullRequestPrompt(coding) });
		}
	}

	function recoverCodingTask(action: CodingRecoveryAction) {
		if (action.prompt) return void sendCodingFollowUp({ text: action.prompt });
		// The thread never started: send the last request again, attachments included.
		const last = chat.messages.findLast((m) => m.role === 'user');
		if (last) void sendCodingFollowUp({ parts: last.parts });
	}

	function regenerate(messageId: string) {
		chat.regenerate({ messageId });
		activeChats.set(conversation.id, chat);
	}

	// ── editing ──────────────────────────────────────────────────────────────
	// The edited message and its replies stay visible until the edit is sent;
	// cancelling restores whatever was in the composer before.
	type FilePart = ReturnType<typeof messageFiles>[number];
	type Editing = {
		messageId: string;
		/** The edited message's attachments, sent again as they are unless removed. */
		keptFiles: FilePart[];
		before: { text: string; files: File[] };
	};
	let editing = $state.raw<Editing | null>(null);
	// An edit can be sent with just the attachments it kept.
	const canSend = $derived(hasContent || (editing?.keptFiles.length ?? 0) > 0);

	function startEdit(messageId: string, text: string) {
		const message = chat.messages.find((m) => m.id === messageId);
		if (!message) return;
		// The original message is kept as the older version, attachments and all,
		// so the edit can reference the same uploads instead of re-uploading them.
		editing = {
			messageId,
			keptFiles: messageFiles(message).map((part) => ({ ...part })),
			before: editing?.before ?? { text: input, files: selectedFiles }
		};
		clearFiles();
		input = text;
		void tick().then(() => composerTextarea()?.focus());
	}

	/** ↑ in an empty composer edits your last message, like the timeline's edit button. */
	function editLastOnArrowUp(event: KeyboardEvent) {
		if (event.key !== 'ArrowUp' || event.altKey || event.ctrlKey || event.metaKey) return;
		if (event.shiftKey || event.isComposing) return;
		if (isCoding || streaming || sending || switchingBranch || editing || hasContent) return;
		const last = chat.messages.findLast((m) => m.role === 'user');
		if (!last) return;
		event.preventDefault();
		startEdit(last.id, messageText(last));
	}

	function removeKeptFile(part: FilePart) {
		if (!editing) return;
		editing = { ...editing, keptFiles: editing.keptFiles.filter((p) => p !== part) };
	}

	// ── versions ─────────────────────────────────────────────────────────────
	let switchingBranch = $state(false);

	type BranchPage = { messages: ChatMessage[]; hasOlder: boolean };

	/**
	 * Runs a request that answers with the conversation's newest page on its active
	 * path, and shows that page in place of the list (older pages of the previous
	 * path no longer apply).
	 */
	async function loadBranchPage(url: string, init: RequestInit | undefined, failure: string) {
		if (streaming || sending || switchingBranch) return;
		const id = conversation.id;
		switchingBranch = true;
		try {
			const res = await fetch(url, init);
			if (!res.ok) throw new Error(errorText(new Error(await res.text())) || String(res.status));
			const page = (await res.json()) as BranchPage;
			if (conversation.id !== id || streaming || sending) return;
			if (editing) cancelEdit();
			recordTimes(page.messages);
			chat.messages = reuseUnchanged(chat.messages, page.messages.map(chatMessageToUIMessage));
			hasOlder = page.hasOlder;
			olderFailed = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : failure);
		} finally {
			switchingBranch = false;
		}
	}

	const branchUrl = (suffix = '') =>
		`/api/conversations/${encodeURIComponent(conversation.id)}/branch${suffix}`;

	/** Shows another version of a message: the server's path through it replaces the list. */
	function switchBranch(messageId: string) {
		return loadBranchPage(
			branchUrl(),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ messageId })
			},
			"Couldn't switch versions"
		);
	}

	/** Deletes a version and its replies; the newest remaining version is shown. */
	function deleteBranch(messageId: string) {
		return loadBranchPage(
			branchUrl(`/${encodeURIComponent(messageId)}`),
			{ method: 'DELETE' },
			"Couldn't delete this version"
		);
	}

	// Another tab switched, deleted or added a version: show the active path again.
	// This tab's own changes arrive here too; while it streams or switches it
	// already shows the right path, and otherwise reloading is harmless.
	$effect(() => {
		const id = conversation.id;
		return onServerEvent((event) => {
			if (event.type !== 'conversation.branch_changed' || event.conversationId !== id) return;
			if (streaming || sending || switchingBranch || editing) return;
			void loadBranchPage(
				`/api/conversations/${encodeURIComponent(id)}/messages`,
				undefined,
				"Couldn't load the latest version"
			);
		});
	});

	function cancelEdit() {
		const edit = editing;
		if (!edit) return;
		editing = null;
		clearFiles();
		input = edit.before.text;
		if (edit.before.files.length > 0) addFiles(edit.before.files);
	}

	let region = $state<HTMLElement>();
	function composerTextarea(): HTMLTextAreaElement | null {
		return region?.querySelector<HTMLTextAreaElement>('textarea[data-composer]') ?? null;
	}

	// Keep the unsent text per chat; an edit in progress isn't a draft.
	$effect(() => {
		const text = input;
		if (editing) return;
		drafts.set(conversation.id, text);
	});

	onMount(() =>
		registerChatShortcuts({
			escape: () => {
				if (streaming) {
					void stop();
					return true;
				}
				if (editing) {
					cancelEdit();
					return true;
				}
				return false;
			},
			lastReply: () => {
				const last = chat.messages.findLast((m) => m.role === 'assistant');
				return (last && messageText(last)) || null;
			}
		})
	);

	// ── earlier messages ─────────────────────────────────────────────────────
	// The page loads only the newest messages; earlier pages are fetched when
	// the user scrolls near the top (or clicks the button there).
	const OLDER_PAGE_SIZE = 60;
	let scrollEl = $state<HTMLDivElement | null>(null);
	let olderSentinel = $state<HTMLElement | null>(null);
	let loadingOlder = $state(false);
	let olderFailed = $state(false);
	let nearTop = $state(false);
	// Not until the user scrolls up: the timeline starts at the top for a frame
	// before it sticks to the bottom.
	let autoLoad = $state(false);

	async function loadOlder() {
		const oldest = chat.messages[0];
		if (!hasOlder || loadingOlder || !oldest) return;
		const id = conversation.id;
		loadingOlder = true;
		olderFailed = false;
		try {
			const params = new URLSearchParams({ before: oldest.id, limit: String(OLDER_PAGE_SIZE) });
			const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/messages?${params}`);
			if (!res.ok) throw new Error(String(res.status));
			const page = (await res.json()) as { messages: ChatMessage[]; hasOlder: boolean };
			// The list was reloaded meanwhile; the next scroll asks again.
			if (conversation.id !== id || chat.messages[0]?.id !== oldest.id) return;
			recordTimes(page.messages);
			// Keep the visible messages in place while content grows above them.
			const el = scrollEl;
			const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
			chat.messages = prependOlder(chat.messages, page.messages.map(chatMessageToUIMessage));
			hasOlder = page.hasOlder;
			await tick();
			if (el) el.scrollTop = el.scrollHeight - fromBottom;
		} catch {
			olderFailed = true;
		} finally {
			loadingOlder = false;
		}
	}

	$effect(() => {
		const root = scrollEl;
		const target = olderSentinel;
		if (!root || !target) {
			nearTop = false;
			return;
		}
		const observer = new IntersectionObserver(([entry]) => (nearTop = entry.isIntersecting), {
			root,
			rootMargin: '600px 0px 0px 0px'
		});
		observer.observe(target);
		return () => observer.disconnect();
	});

	$effect(() => {
		const el = scrollEl;
		if (!el || autoLoad) return;
		let last = el.scrollTop;
		const onScroll = () => {
			if (el.scrollTop < last - 4) autoLoad = true;
			last = el.scrollTop;
		};
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	});

	$effect(() => {
		if (nearTop && autoLoad && hasOlder && !loadingOlder && !olderFailed) {
			untrack(() => void loadOlder());
		}
	});

	const fileDrop = createFileDrop((files) => {
		addFiles(files);
	});

	// Ctrl+V with a copied file or image attaches it, like dropping it would.
	function pasteFiles(e: ClipboardEvent) {
		const files = clipboardFiles(e.clipboardData);
		if (files.length === 0) return;
		e.preventDefault();
		addFiles(files);
	}

	// Navigating away destroys this view (the page uses {#key}); make sure the
	// sidebar indicator doesn't keep spinning for a chat we're no longer showing.
	// Also drop this view's stream connection: the reply keeps running server-side
	// (and is replayed on return), but an orphaned fetch would hold one of the
	// browser's ~6 HTTP/1.1 connections per host until the reply ends, so
	// switching between a few long-running chats would leave every other request
	// pending.
	onMount(() => {
		const id = conversation.id;
		return () => {
			if (activeChats.get(id) === chat) {
				activeChats.delete(id);
			}
			void chat.stop();
		};
	});

	function addFiles(incoming: File[]) {
		// Each File is its own entry (and list key); adding one twice is a no-op.
		const files = incoming.filter((f) => !selectedFiles.includes(f));
		selectedFiles = [...selectedFiles, ...files];
	}

	function removeFile(file: File) {
		selectedFiles = selectedFiles.filter((f) => f !== file);
	}

	function clearFiles() {
		selectedFiles = [];
	}

	function pickFiles() {
		fileInput?.click();
	}

	function filesChosen(e: Event) {
		const target = e.currentTarget as HTMLInputElement;
		addFiles(Array.from(target.files ?? []));
		target.value = '';
	}
</script>

<div
	bind:this={region}
	class="relative flex h-full min-h-0 flex-1 flex-col"
	role="region"
	aria-label="Chat"
	ondragenter={fileDrop.ondragenter}
	ondragover={fileDrop.ondragover}
	ondragleave={fileDrop.ondragleave}
	ondrop={fileDrop.ondrop}
	onpaste={pasteFiles}
>
	{#if fileDrop.dragActive}
		<div
			class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-info bg-background/70"
		>
			<span class="text-sm font-medium text-muted-foreground">Drop files to attach</span>
		</div>
	{/if}

	<ChatTopbar
		{conversation}
		{groups}
		{mappings}
		{defaultModel}
		{personas}
		{coding}
		{codingEnvironmentName}
		{codingBrowserActivity}
		oncreatepr={isCoding ? createPullRequest : undefined}
		onrecover={isCoding ? recoverCodingTask : undefined}
		{codingEnvironments}
		{codingAgents}
		handoffDisabled={streaming || chat.messages.length === 0}
		messageCount={chat.messages.length}
		onupdated={(updated) => (conversation = updated)}
	/>

	<!-- Reserve the scrollbar on both sides so messages stay centred over the composer. -->
	<ChatContainer
		bind:context={scroll}
		bind:ref={scrollEl}
		aria-busy={streaming}
		class="min-h-0 flex-1 [scrollbar-gutter:stable_both-edges]"
	>
		<ChatContainerContent>
			{#if hasOlder}
				<div bind:this={olderSentinel} class="flex justify-center px-4 pt-4">
					<Button variant="outline" size="sm" disabled={loadingOlder} onclick={() => loadOlder()}>
						{#if loadingOlder}
							<LoaderIcon class="size-4 animate-spin" />
						{/if}
						{olderFailed ? "Couldn't load earlier messages — retry" : 'Load earlier messages'}
					</Button>
				</div>
			{/if}
			<MessageTimeline
				messages={chat.messages}
				{streaming}
				{timeFormat}
				{messageTimes}
				conversationId={conversation.id}
				onregenerate={isCoding ? undefined : regenerate}
				onedit={isCoding ? undefined : startEdit}
				onswitchbranch={isCoding ? undefined : switchBranch}
				ondeletebranch={isCoding ? undefined : deleteBranch}
				branchDisabled={streaming || sending || switchingBranch}
				editingId={editing?.messageId ?? null}
			/>
			{#if waiting}
				<ThinkingIndicator since={waitingSince} class="mx-auto w-full max-w-3xl px-4 pb-4" />
			{/if}
		</ChatContainerContent>
	</ChatContainer>
	<div role="status" class="sr-only">{replyAnnouncement}</div>

	<div class="relative mx-auto w-full max-w-3xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
		{#if showJumpToLatest}
			<Button
				variant="outline"
				size="icon"
				class="absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 rounded-full bg-background shadow-md dark:bg-background"
				title="Jump to latest"
				onclick={() => scroll?.scrollToBottom()}
			>
				<ArrowDownIcon class="size-4" />
				{#if streaming}
					<span
						class="absolute top-0 right-0 size-2.5 rounded-full border-2 border-background bg-info"
						aria-hidden="true"
					></span>
				{/if}
				<span class="sr-only">
					{streaming ? 'Jump to latest, new content is arriving' : 'Jump to latest'}
				</span>
			</Button>
		{/if}
		{#if coding?.pendingRequest}
			{#key coding.pendingRequest.requestId}
				<CodingPendingRequest
					conversationId={conversation.id}
					request={coding.pendingRequest}
					onresponded={() => void refreshCoding().catch(() => undefined)}
				/>
			{/key}
		{:else if coding?.status === 'failed' && coding.lastError}
			<p class="mb-2 px-1 text-sm break-words text-destructive">{coding.lastError}</p>
		{/if}
		{#if queue.length > 0}
			<QueuedMessages
				items={queue}
				paused={queuePaused}
				busy={streaming}
				disabled={sending}
				onsendnow={sendQueuedNow}
				onedit={editQueued}
				onremove={(item) => messageQueue.remove(conversation.id, item.id)}
				onresume={() => messageQueue.resume(conversation.id)}
			/>
		{/if}
		{#if editing}
			<div
				class="mb-2 flex items-center gap-2 rounded-md border bg-muted/50 py-1 pr-1 pl-3 text-sm text-muted-foreground"
			>
				<PencilIcon class="size-3.5 shrink-0" />
				<span class="min-w-0 flex-1 truncate">Editing message</span>
				{#each editing.keptFiles as part (part)}
					<span
						class="flex max-w-40 items-center gap-1 rounded border bg-background py-0.5 pr-0.5 pl-1.5 text-xs"
						title={part.filename ?? 'Attachment'}
					>
						<FileIcon class="size-3 shrink-0" />
						<span class="truncate">{part.filename ?? 'Attachment'}</span>
						<button
							type="button"
							aria-label="Remove {part.filename ?? 'attachment'}"
							class="rounded p-0.5 hover:bg-accent"
							onclick={() => removeKeptFile(part)}
						>
							<XIcon class="size-3" />
						</button>
					</span>
				{/each}
				<Button
					variant="ghost"
					size="sm"
					class="h-7"
					title="Cancel editing ({shortcutLabel('escape')})"
					onclick={cancelEdit}
				>
					Cancel
				</Button>
			</div>
		{/if}
		<PromptInput
			value={displayInput}
			onValueChange={(v) => (input = v)}
			onSubmit={() => send(displayInput)}
		>
			<PendingAttachments files={selectedFiles} onremove={removeFile} />
			<PromptInputTextarea
				onkeydown={editLastOnArrowUp}
				placeholder={editing
					? 'Edit your message…'
					: streaming
						? 'Queue a follow-up message…'
						: 'Ask anything…'}
			/>
			<PromptInputActions class="justify-between">
				<div class="flex items-center gap-1">
					<Button variant="ghost" size="icon" aria-label="Attach files" onclick={pickFiles}>
						<PaperclipIcon class="size-4" />
					</Button>
					<MicButton {speech} />
				</div>
				{#if streaming && !canSend}
					<Button
						size="sm"
						variant="destructive"
						aria-label="Stop"
						title="Stop ({shortcutLabel('escape')})"
						onclick={stop}
					>
						<SquareIcon class="size-4" />
					</Button>
				{:else}
					{@const queues = (streaming || sending) && !editing}
					<Button
						size="sm"
						disabled={!canSend}
						aria-label={queues ? 'Queue message' : 'Send'}
						title={queues ? 'Queue — sends when the reply finishes' : undefined}
						onclick={() => send(displayInput)}
					>
						{#if queues}
							<ListEndIcon class="size-4" />
						{:else}
							<ArrowUpIcon class="size-4" />
						{/if}
					</Button>
				{/if}
			</PromptInputActions>
		</PromptInput>
		<input
			bind:this={fileInput}
			type="file"
			multiple
			accept="image/*,application/pdf,.txt,.md,.csv,.json,.xml,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip"
			class="hidden"
			onchange={filesChosen}
		/>
	</div>
</div>
