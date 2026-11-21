<script lang="ts">
	import { Chat } from '@ai-sdk/svelte';
	import { PRIVATE_CHAT_HINT } from '$lib/private-data.js';
	import { DefaultChatTransport } from 'ai';
	import { onMount, tick, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { page } from '$app/state';
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
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import LockIcon from '@lucide/svelte/icons/lock';
	import ChatTopbar from './ChatTopbar.svelte';
	import { setChatViewContext } from './chat-view-context.js';
	import CodingPendingRequest from './CodingPendingRequest.svelte';
	import MessageTimeline from './MessageTimeline.svelte';
	import MessageNav from './MessageNav.svelte';
	import { hasVisibleContent } from './timeline.js';
	import ThinkingIndicator from './ThinkingIndicator.svelte';
	import WaitingIndicator from './WaitingIndicator.svelte';
	import { activeChats } from '$lib/state/active-chats.svelte.js';
	import {
		canCreatePullRequest,
		createPullRequestPrompt,
		recoveryAction,
		type CodingRecoveryAction
	} from '$lib/coding-task-details.js';
	import { onServerEvent, onServerEventResync } from '$lib/state/events.svelte.js';
	import { scheduleInvalidate } from '$lib/state/invalidate-when-idle.js';
	import { CONVERSATIONS_KEY } from '$lib/load-keys.js';
	import { askUserInput, askUserRequest, isAskUserPart, type AskUserPart } from '$lib/ask-user.js';
	import { drafts } from '$lib/state/drafts.js';
	import { registerChatShortcuts, shortcutLabel } from '$lib/state/shortcuts.js';
	import { registerCommands } from '$lib/state/commands.js';
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import {
		messageFiles,
		messageText,
		prependOlder,
		reuseUnchanged,
		withLatestPage
	} from '$lib/chat-history.js';
	import { pendingMessage, pendingVoice } from '$lib/state/pending-message.svelte.js';
	import { startFlight } from '$lib/send-flight.js';
	import { messageQueue, type QueuedMessage } from '$lib/state/message-queue.svelte.js';
	import QueuedMessages from './QueuedMessages.svelte';
	import { parseSkillCommand, uploadAttachments } from '$lib/chat-send.js';
	import { createFileDrop } from '$lib/state/file-drop.svelte.js';
	import PendingAttachments from './PendingAttachments.svelte';
	import { clipboardFiles } from '$lib/state/clipboard-files.js';
	import { haptic } from '$lib/haptics.svelte.js';
	import MicButton from '$lib/components/app/MicButton.svelte';
	import { createSpeechRecognition } from '$lib/state/speech-recognition.svelte.js';
	import { createServerSpeechRecognition } from '$lib/state/server-speech-recognition.svelte.js';
	import { createSpeechPlayback } from '$lib/state/speech-playback.svelte.js';
	import { createVoiceMode, voiceModeSupported } from '$lib/state/voice-mode.svelte.js';
	import { localVoiceCount } from '$lib/state/local-voices.svelte.js';
	import VoiceBar from './VoiceBar.svelte';
	import VoiceModeButton from './VoiceModeButton.svelte';
	import {
		chatMessageToUIMessage,
		type Agent,
		type ChatMessage,
		type Conversation,
		type DispatchInfo,
		type ModelMapping,
		type PickerModelGroup,
		type PrivateDataStatus,
		type UIMessage,
		type UIMessageMetadata
	} from '$lib/types.js';
	import type { TimeFormat } from '$lib/user-settings.js';
	import {
		acceptsTypedAnswer,
		type CodingConversation,
		type CodingEnvironment
	} from '$lib/coding-environments.js';
	import { browserActivity } from '$lib/coding-preview.js';
	import { PRIVATE_DATA_OFF } from '$lib/private-data.js';
	import { setPrivateChat } from '$lib/private-context.js';
	import {
		micAvailable,
		PRIVATE_MIC_HINT,
		voiceModeAvailable,
		type SpeechPrivacy
	} from '$lib/private-speech.js';

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
		serverTts = false,
		initiallyGenerating = false,
		coding: initialCoding = null,
		codingEnvironments = [],
		codingAgents = [],
		dispatch = null,
		privateData = PRIVATE_DATA_OFF
	}: {
		conversation: Conversation;
		/** The newest page of messages; earlier ones load on scroll. */
		initialMessages: ChatMessage[];
		/** Messages exist before `initialMessages`. */
		hasOlderMessages?: boolean;
		groups: PickerModelGroup[];
		mappings?: ModelMapping[];
		defaultModel?: { providerId: string; modelId: string } | null;
		sttModel?: { providerId: string; modelId: string } | null;
		/** A Text to speech default is set; otherwise the browser's voice reads replies. */
		serverTts?: boolean;
		timeFormat?: TimeFormat;
		personas?: Agent[];
		initiallyGenerating?: boolean;
		/** Set when this conversation is a coding task run by a remote agent. */
		coding?: CodingConversation | null;
		/** Targets for handing this chat off to a coding agent. */
		codingEnvironments?: CodingEnvironment[];
		codingAgents?: Agent[];
		/** Set when Chatty started this chat for an agent run. */
		dispatch?: DispatchInfo | null;
		/** The app shell's private-data switches (layout data `privateData`). */
		privateData?: PrivateDataStatus;
	} = $props();

	// Local edits apply immediately; reloaded page data (e.g. a task settled or
	// renamed on T3) replaces them.
	let conversation = $derived(initialConversation);
	// Coding tasks proposed in this chat (`propose_coding_task`) start from here.
	setChatViewContext(() => ({
		conversationId: conversation.id,
		codingEnvironments,
		codingAgents
	}));
	// ── privacy ──────────────────────────────────────────────────────────────
	// Private chats only run on trusted models. A chat turns private on its own
	// (for good) when a turn reads private data: the server says so with an event.
	const isPrivate = $derived(privateData.enabled && conversation.private);
	$effect(() => {
		const id = conversation.id;
		return onServerEvent((event) => {
			if (event.type !== 'conversation.privacy' || event.conversationId !== id) return;
			// The reply itself shows where it became private (a notice part).
			conversation = { ...conversation, private: event.private };
		});
	});

	// Widgets (the map) hold back third-party requests in a private chat.
	// Speech and widgets follow the stored flag itself (safe side, even with the feature off).
	setPrivateChat(() => conversation.private);

	// Speech in a private chat stays with trusted server models or on the device:
	// no browser recognition (Chrome sends the audio to Google), server read-aloud
	// only when the Text to speech model is trusted (else on-device voices only).
	const speechPrivacy = (): SpeechPrivacy => ({
		conversationId: conversation.id,
		private: conversation.private
	});
	const serverTtsUsable = () => serverTts && (!conversation.private || privateData.ttsTrusted);
	/** Why the mic is off here, when the chat is private and no trusted speech to text is set. */
	const micBlocked = $derived(
		isPrivate &&
			!micAvailable({
				isPrivate,
				sttTrusted: privateData.sttTrusted,
				sttConfigured: sttModel !== null
			})
			? PRIVATE_MIC_HINT
			: undefined
	);

	// The unsent text survives switching chats (this view remounts per chat).
	let input = $state(drafts.get(untrack(() => initialConversation.id)));
	const initialSttModel = untrack(() => sttModel);
	const speech = initialSttModel
		? createServerSpeechRecognition(initialSttModel, { privacy: speechPrivacy })
		: createSpeechRecognition({ private: () => conversation.private });
	// Turned private mid-dictation: stop listening rather than keep sending audio out.
	$effect(() => {
		if (micBlocked && (speech.recording || speech.busy)) untrack(() => speech.stop());
	});
	const playback = createSpeechPlayback({
		serverTts: serverTtsUsable,
		privacy: speechPrivacy,
		onerror: (message) => toast.error(message),
		oninfo: (message) => toast.info(message),
		volume: () => page.data.settings?.speechVolume ?? 1
	});
	onMount(() => playback.stop);

	// ── voice mode ───────────────────────────────────────────────────────────
	// A spoken conversation in this chat: each turn is sent as a regular
	// message and the reply is read aloud as it streams in.
	const voiceSupported = $derived(
		voiceModeSupported(sttModel, serverTtsUsable(), conversation.private) &&
			voiceModeAvailable({
				isPrivate,
				sttTrusted: privateData.sttTrusted,
				sttConfigured: sttModel !== null,
				// It must also answer out loud without the reply leaving the device.
				ttsTrusted: privateData.ttsTrusted,
				ttsConfigured: serverTts,
				localVoiceCount: localVoiceCount()
			})
	);
	const voice = createVoiceMode({
		sttModel: untrack(() => sttModel),
		serverTts: serverTtsUsable,
		privacy: speechPrivacy,
		volume: () => page.data.settings?.speechVolume ?? 1,
		send: (text) => submit(text, []),
		// The user went on talking before the reply was heard: their message is
		// replaced (as an edit, so the cut-off reply stays as an older version).
		revise: (text) => {
			const last = chat.messages.findLast((m) => m.role === 'user');
			return last ? deliver(text, [], { messageId: last.id, keptFiles: [] }) : submit(text, []);
		},
		interrupt: () => void stop(),
		onerror: (message) => toast.error(message)
	});
	onMount(() => voice.stop);

	/** Dictation is recording or transcribing: Voice mode isn't offered meanwhile. */
	const dictating = $derived(speech.recording || speech.busy);

	// Ending voice mode brings the composer back: focus goes to it, as it was
	// on the Voice button when voice mode started (desktop only, so phones
	// don't throw up the keyboard).
	let voiceWasShown = false;
	let voiceWasActive = false;
	/** Announces voice mode starting and ending (the bar itself is gone once it ends). */
	let voiceAnnouncement = $state('');
	$effect(() => {
		// Shown also covers a start that failed (mic denied): the composer comes back either way.
		const shown = voice.active || voice.phase === 'starting';
		const active = voice.active;
		if (active && !voiceWasActive) voiceAnnouncement = 'Voice mode on';
		if (voiceWasActive && !active) voiceAnnouncement = 'Voice mode off';
		if (voiceWasShown && !shown && window.matchMedia('(pointer: fine)').matches) {
			void tick().then(() => composerTextarea()?.focus());
		}
		voiceWasShown = shown;
		voiceWasActive = active;
	});

	function startVoice() {
		speech.stop();
		speech.reset();
		playback.stop();
		haptic('light');
		void voice.start();
	}
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
	function showLatest(messages = initialMessages, older = hasOlderMessages) {
		recordTimes(messages);
		const latest = withLatestPage(chat.messages, messages.map(chatMessageToUIMessage));
		if (!latest.keptOlder) hasOlder = older;
		// Unchanged messages keep their objects, so the timeline only re-renders
		// what actually changed (background updates arrive often on long tasks).
		chat.messages = reuseUnchanged(chat.messages, latest.messages);
	}

	/**
	 * The newest page of messages, as the page load sends it. Reloading just these
	 * after a reply is far cheaper than rerunning the page and layout loads (which
	 * would also drop SvelteKit's hover preloads); conversation changes such as a
	 * new title arrive as their own server events.
	 */
	async function fetchLatest(
		id: string
	): Promise<{ messages: ChatMessage[]; hasOlder: boolean } | null> {
		const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/messages`).catch(
			() => null
		);
		if (!res?.ok) return null;
		return (await res.json().catch(() => null)) as {
			messages: ChatMessage[];
			hasOlder: boolean;
		} | null;
	}

	const streaming = $derived(
		chat.status === 'streaming' || chat.status === 'submitted' || remoteGenerating
	);
	const lastAssistant = $derived(chat.messages.findLast((m) => m.role === 'assistant'));
	/**
	 * How full the model's context is, as of the latest reply that measured it.
	 * Replies without usage (failed, stopped early) are skipped; one recorded
	 * before context was measured ends the search, since older figures are stale.
	 */
	const contextUsage = $derived.by(() => {
		for (let i = chat.messages.length - 1; i >= 0; i--) {
			const message = chat.messages[i];
			if (message.role !== 'assistant') continue;
			const usage = (message.metadata as UIMessageMetadata | undefined)?.usage;
			if (!usage) continue;
			if (!usage.contextTokens) return null;
			return {
				tokens: usage.contextTokens,
				length: usage.contextLength ?? null,
				modelId: usage.modelId
			};
		}
		return null;
	});

	$effect(() => {
		const reply = lastAssistant ? { id: lastAssistant.id, text: messageText(lastAssistant) } : null;
		const busy = streaming || sending;
		untrack(() => voice.observe(reply, busy));
	});
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
	// The run ended but resumes by itself once its background work reports back
	// (the sidebar's "Waiting"): said at the end of the log too.
	const backgroundWaiting = $derived(coding?.status === 'waiting' && !waiting && !streaming);
	const hasContent = $derived(displayInput.trim().length > 0 || selectedFiles.length > 0);

	let scroll = $state<ChatContainerContext>();
	// Only new output glides into view. Everything else that resizes the log —
	// code highlighting, diagrams, images and widgets settling after a reload, or
	// a replayed stream catching up — snaps, so the view doesn't creep down.
	let settled = $state(false);
	onMount(() => {
		const timer = setTimeout(() => (settled = true), 1000);
		return () => clearTimeout(timer);
	});
	const followAnimation = $derived(streaming && settled ? 'smooth' : 'instant');
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
	$effect(() => {
		if (backgroundWaiting) replyAnnouncement = 'Waiting on background work';
	});
	let sending = $state(false);

	async function markRead({ refresh = true } = {}) {
		await fetch(`/api/conversations/${conversation.id}/read`, { method: 'POST' }).catch(
			() => undefined
		);
		// Only the sidebar's unread markers change; the page itself is current.
		// Batched with the sidebar's own refresh for the same reply finishing.
		if (refresh) await scheduleInvalidate(CONVERSATIONS_KEY);
	}

	const localBusy = () => chat.status === 'streaming' || chat.status === 'submitted' || sending;

	/** Whether the server is still generating a reply for `id`; null when it couldn't be asked. */
	async function isGeneratingRemotely(id: string): Promise<boolean | null> {
		const res = await fetch('/api/chat/active').catch(() => null);
		if (!res?.ok) return null;
		const data = (await res.json().catch(() => null)) as { conversationIds?: unknown } | null;
		return Array.isArray(data?.conversationIds) ? data.conversationIds.includes(id) : null;
	}

	const RESUME_RETRY_MAX_MS = 10_000;
	/** A connection that lasted this long was working: the next drop retries quickly again. */
	const RESUME_HEALTHY_MS = 10_000;
	/** Bumped when this view stops following (stop, a new message, unmount): pending retries drop out. */
	let resumeEpoch = 0;
	let resumeTimer: ReturnType<typeof setTimeout> | undefined;

	function cancelResumeRetry() {
		resumeEpoch++;
		clearTimeout(resumeTimer);
	}
	onMount(() => cancelResumeRetry);

	/**
	 * A stream is (or was) running server-side. Attach to it for live tokens.
	 * When the connection ends, the reply may still be running: the connection
	 * dropped, or the server had nothing to replay (a 204 when its replay buffer
	 * overflowed). Then keep showing it as live, with the persisted progress, and
	 * attach again until the server says it's done.
	 */
	function resumeRemoteStream(attempt = 0) {
		const id = conversation.id;
		const epoch = resumeEpoch;
		const startedAt = Date.now();
		chat
			.resumeStream()
			.catch(() => undefined)
			.finally(async () => {
				if (chat.status === 'streaming' || chat.status === 'submitted') return;
				const generating = epoch === resumeEpoch ? await isGeneratingRemotely(id) : false;
				if (conversation.id !== id || localBusy()) return;
				if (generating === false || epoch !== resumeEpoch || !remoteGenerating) {
					remoteGenerating = false;
					void reloadLatest(id);
					return;
				}
				// Still running, or the server couldn't be asked (offline): the
				// finish event or a resync settles it; until then keep reattaching.
				void reloadLatest(id);
				const next = Date.now() - startedAt >= RESUME_HEALTHY_MS ? 0 : attempt + 1;
				resumeTimer = setTimeout(
					() => {
						if (epoch !== resumeEpoch || !remoteGenerating || localBusy()) return;
						if (conversation.id === id) resumeRemoteStream(next);
					},
					Math.min(1000 * 2 ** next, RESUME_RETRY_MAX_MS)
				);
			});
	}

	/** A reply shown as still being generated ('partial') although none is being received. */
	function showsUnsettledReply(): boolean {
		return chat.messages.some(
			(m) => (m.metadata as UIMessageMetadata | undefined)?.status === 'partial'
		);
	}

	/** Shows the persisted newest messages, unless a new reply has started meanwhile. */
	async function reloadLatest(id: string) {
		const latest = await fetchLatest(id);
		if (!latest || conversation.id !== id || localBusy()) return;
		showLatest(latest.messages, latest.hasOlder);
	}

	const wasUnread = untrack(
		() => (page.data.unreadIds as string[] | undefined)?.includes(conversation.id) ?? true
	);

	onMount(() => {
		if (remoteGenerating) resumeRemoteStream();
		// Opening a chat that was already read changes no marker, so skip the
		// sidebar reload (it would also drop SvelteKit's hover preloads).
		else markRead({ refresh: wasUnread });
	});

	// A reply started elsewhere while this view is open (another tab, a turn
	// started on T3). Streams this tab started itself are already attached.
	$effect(() => {
		const id = conversation.id;
		return onServerEvent((event) => {
			if (event.type !== 'chat.stream.started' || event.conversationId !== id) return;
			if (remoteGenerating) return;
			// Usually this view's own reply; but the server may already have sent
			// the next queued message while ours winds down: checked once idle.
			if (localBusy()) startedWhileBusy = true;
			else void followRemoteStream(id);
		});
	});

	let startedWhileBusy = false;

	/** Follows a reply that started while this view was busy with its own, if it still runs. */
	async function followIfStartedWhileBusy(id: string) {
		if (!startedWhileBusy) return;
		startedWhileBusy = false;
		if ((await isGeneratingRemotely(id)) !== true) return;
		if (conversation.id !== id || remoteGenerating || localBusy()) return;
		await followRemoteStream(id);
	}

	/** Attaches to a reply running server-side that this view didn't start. */
	async function followRemoteStream(id: string) {
		remoteGenerating = true;
		// Pick up the user message that started the turn before attaching.
		const latest = await fetchLatest(id);
		if (!remoteGenerating || localBusy() || conversation.id !== id) return;
		if (latest) showLatest(latest.messages, latest.hasOlder);
		resumeRemoteStream();
	}

	$effect(() => {
		if (pendingVoice.consume(conversation.id)) untrack(startVoice);
		const pending = pendingMessage.consume(conversation.id);
		if (!pending) return;
		untrack(() => {
			if (pending.files.length > 0) addFiles(pending.files);
			void send(pending.text);
			// Just started from the new-chat page: keep typing here. Desktop (fine
			// pointer) only, so touch devices don't get the keyboard thrown up.
			if (window.matchMedia('(pointer: fine)').matches) {
				void tick().then(() => composerTextarea()?.focus());
			}
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
			// One sidebar reload (batched with the sidebar's own for this event) and
			// the new messages, instead of reloading the whole page as well.
			const read = markRead();
			const latest = await fetchLatest(id);
			// A queued message may already be on its way; don't wipe it.
			if (latest && conversation.id === id && !localBusy()) {
				showLatest(latest.messages, latest.hasOlder);
			}
			await read;
		};
		const offEvent = onServerEvent((event) => {
			if (event.type === 'chat.stream.finished' && event.conversationId === id) {
				void finish();
			}
		});
		const offResync = onServerEventResync(() => {
			void (async () => {
				if ((await isGeneratingRemotely(id)) === false) await finish();
			})().catch(() => {});
		});
		return () => {
			offEvent();
			offResync();
		};
	});

	// Messages can change with no stream attached (a coding task's background
	// subagent reporting progress after its turn ended, a proposed coding task's
	// "finished" notice in a chat); reload them while idle. Only the newest page
	// is fetched: these updates can arrive every second, and reloading the whole
	// page data would also re-send the layout and model list.
	//
	// A reload can also catch a reply the server hasn't settled yet: Stop aborts
	// the server's side without waiting, so the messages reloaded right after can
	// still hold it as 'partial' ("Still generating…") with nothing attached to
	// end it. The server announces `chat.stream.finished` once it has saved the
	// final state, so reload then too whenever such a stale reply is shown.
	$effect(() => {
		const id = conversation.id;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const reload = async (onlyIfStale = false) => {
			timer = null;
			if (streaming || conversation.id !== id) return;
			if (onlyIfStale && !showsUnsettledReply()) return;
			const latest = await fetchLatest(id);
			if (!latest || streaming || sending || conversation.id !== id) return;
			showLatest(latest.messages, latest.hasOlder);
		};
		const off = onServerEvent((event) => {
			if (event.type === 'chat.messages.updated' && event.conversationId === id) {
				timer ??= setTimeout(() => void reload(), 300);
			} else if (
				event.type === 'chat.stream.finished' &&
				event.conversationId === id &&
				!remoteGenerating
			) {
				// Following a remote reply settles it itself (see `finish` above).
				// Checked after the delay: a reload already in flight may only now
				// bring in the stale reply.
				timer ??= setTimeout(() => void reload(true), 300);
			}
		});
		return () => {
			off();
			if (timer) clearTimeout(timer);
		};
	});

	/**
	 * The reply this view was receiving errored. If the server is still generating
	 * it, only the connection dropped: follow the reply instead of showing it as
	 * ended. Otherwise show the failure. (The server pauses the queue itself when
	 * a reply fails.)
	 */
	async function recoverFromError(id: string) {
		if ((await isGeneratingRemotely(id)) === true) {
			if (conversation.id !== id || chat.status !== 'error' || remoteGenerating) return;
			await followRemoteStream(id);
			return;
		}
		await reloadAfterError(id);
	}

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
			isGeneratingRemotely(id)
				.then((generating) => {
					if (generating === false) done();
				})
				.catch(() => {});
		});
		if (conversation.id !== id || chat.status !== 'error') return;
		const latest = await fetchLatest(id);
		if (!latest || conversation.id !== id || chat.status !== 'error') return;
		showLatest(latest.messages, latest.hasOlder);
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
				void recoverFromError(id);
			});
		}
		if (prevStatus !== 'ready' && current === 'ready') {
			markRead();
			void followIfStartedWhileBusy(conversation.id);
			if (activeChats.get(conversation.id) === chat) {
				activeChats.delete(conversation.id);
			}
		}
		prevStatus = current;
	});

	const INTERRUPT_TIMEOUT_MS = 2000;

	// ── queue ────────────────────────────────────────────────────────────────
	// Messages written while a reply runs wait in the server's queue, which sends
	// them one by one once the chat is idle (this view follows those replies like
	// any started elsewhere). "Send now" interrupts the reply instead.
	const queue = $derived(messageQueue.list(conversation.id));
	const queuePaused = $derived(messageQueue.isPaused(conversation.id));
	/** A queue action (send now, edit) is in flight; its buttons would race it. */
	let queueActing = $state(false);
	/** The message being delivered, if any: a message queued meanwhile goes after it. */
	let delivering: Promise<boolean> | null = null;

	$effect(() => {
		const id = conversation.id;
		untrack(() => void messageQueue.load(id).catch(() => undefined));
	});

	/**
	 * Send from the composer itself: as `send`, with the text gliding into the
	 * message it becomes, or into the queue. (Not for edits or typed answers to a
	 * coding task, which don't add a message.)
	 */
	async function sendFromComposer(text: string) {
		const trimmed = text.trim();
		const plain = !editing && !(codingAnswerTarget && trimmed && selectedFiles.length === 0);
		const flight = plain
			? startFlight(composerTextarea(), trimmed, willQueue() ? 'queue' : 'message')
			: null;
		const sent = await send(text);
		if (sent) flight?.land();
		else flight?.cancel();
	}

	/** Sends the composer's message, or queues it while the chat is busy. Resolves true once it's on its way. */
	async function send(text: string): Promise<boolean> {
		speech.stop();
		speech.reset();
		const trimmed = text.trim();
		if (trimmed || selectedFiles.length > 0 || editing?.keptFiles.length) haptic('light');
		if (editing) {
			if (!trimmed && selectedFiles.length === 0 && editing.keptFiles.length === 0) return false;
			// An edit starts a new branch from the edited message, so it never waits in the queue.
			const edit = { messageId: editing.messageId, keptFiles: editing.keptFiles };
			if (!(await deliver(trimmed, selectedFiles, edit))) return false;
			editing = null;
			input = '';
			clearFiles();
			return true;
		}
		if (!trimmed && selectedFiles.length === 0) return false;
		// While the coding task waits on the user, typed text answers it (files
		// can't go with an answer, so a message with attachments is a new turn).
		if (codingAnswerTarget && trimmed && selectedFiles.length === 0) {
			if (!(await answerCodingRequest(codingAnswerTarget.requestId, trimmed))) return false;
			input = '';
			return true;
		}
		if (!(await submit(trimmed, selectedFiles))) return false;
		input = '';
		clearFiles();
		return true;
	}

	/** The coding task's pending request that composer text answers, if any (see send). */
	const codingAnswerTarget = $derived(
		coding?.pendingRequest && acceptsTypedAnswer(coding.pendingRequest)
			? coding.pendingRequest
			: null
	);

	/** Answers the coding task's pending question (or declines its approval) with `text`. */
	async function answerCodingRequest(requestId: string, text: string): Promise<boolean> {
		sending = true;
		try {
			const res = await fetch(`/api/coding/tasks/${encodeURIComponent(conversation.id)}/respond`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ requestId, text })
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(data?.message ?? 'Failed to send your answer');
			}
			void refreshCoding().catch(() => undefined);
			return true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to send your answer');
			return false;
		} finally {
			sending = false;
		}
	}

	/**
	 * Sends a message, or queues it while the chat is busy: behind earlier queued
	 * messages unless the queue waits for the user. Returns false on failure.
	 */
	/** Whether a message submitted now waits in the queue (see submit). */
	function willQueue(): boolean {
		return streaming || sending || (queue.length > 0 && !queuePaused);
	}

	function submit(text: string, files: File[]): Promise<boolean> {
		if (willQueue()) return queueMessage(text, files);
		if (queuePaused) resumeQueueAfterStart(conversation.id);
		return deliver(text, files);
	}

	async function queueMessage(text: string, files: File[]): Promise<boolean> {
		const id = conversation.id;
		try {
			await delivering;
			await messageQueue.add(id, { text, files });
			return true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to queue the message');
			return false;
		}
	}

	/**
	 * A new message goes ahead of a paused queue, which then goes on after its
	 * reply. Resumed once that reply has started, so the server doesn't send the
	 * next queued message first.
	 */
	function resumeQueueAfterStart(id: string) {
		if (messageQueue.list(id).length === 0) {
			messageQueue.resume(id);
			return;
		}
		const timer = setTimeout(done, 30_000);
		const off = onServerEvent((event) => {
			if (event.type !== 'chat.stream.started' || event.conversationId !== id) return;
			done();
			messageQueue.resume(id);
		});
		function done() {
			clearTimeout(timer);
			off();
		}
	}

	/**
	 * The agent's open `ask_user` question: its turn ended on it and nothing has
	 * been said since. Shown in the same answer panel as a coding task's questions.
	 */
	const agentQuestion = $derived.by(() => {
		if (isCoding || streaming) return null;
		const last = chat.messages.at(-1);
		if (last?.role !== 'assistant') return null;
		const part = last.parts.find((p) => isAskUserPart(p)) as AskUserPart | undefined;
		if (!part || part.state !== 'input-available') return null;
		const input = askUserInput(part);
		return input ? askUserRequest(part.toolCallId, input) : null;
	});

	/** What waits on the user, announced once by a live region that stays mounted. */
	const pendingAnnouncement = $derived.by(() => {
		const pending = coding?.pendingRequest ?? agentQuestion?.request ?? null;
		if (!pending) return { polite: '', assertive: '' };
		const approval = pending.kind === 'approval';
		const lead = approval
			? 'The agent needs your approval'
			: pending.kind === 'secret'
				? 'The agent asks for a secret'
				: pending.kind === 'link'
					? 'The agent asks to link a machine'
					: 'The agent has a question';
		const text = `${lead}: ${pending.title}`;
		return approval ? { polite: '', assertive: text } : { polite: text, assertive: '' };
	});

	/** Answers the agent's question: the answer is just the next message, sent like typed text. */
	function answerQuestion(answer: { optionId?: string; text?: string }): Promise<boolean> {
		const chosen = answer.optionId ? agentQuestion?.answers[answer.optionId] : undefined;
		const text = (chosen ?? answer.text ?? '').trim();
		if (!text) return Promise.resolve(false);
		return submit(text, []);
	}

	/**
	 * Interrupts any running reply and sends the message. With `edit`, the
	 * message is a new version of that one: it and everything after it make way
	 * for the new branch (the server keeps them as the older version), and the
	 * edited message's attachments that were kept are sent along as they are.
	 * Returns false on failure.
	 */
	function deliver(
		text: string,
		files: File[],
		edit?: { messageId: string; keptFiles: FilePart[] }
	): Promise<boolean> {
		if (sending) return Promise.resolve(false);
		const done: Promise<boolean> = deliverNow(text, files, edit).finally(() => {
			if (delivering === done) delivering = null;
		});
		delivering = done;
		return done;
	}

	async function deliverNow(
		text: string,
		files: File[],
		edit?: { messageId: string; keptFiles: FilePart[] }
	): Promise<boolean> {
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

	/**
	 * Sends a queued message now: the server starts its turn (superseding the
	 * running reply) and resumes the queue; this view follows the new reply.
	 */
	async function sendQueuedNow(item: QueuedMessage) {
		if (sending || queueActing) return;
		queueActing = true;
		try {
			await interruptResponse();
			await messageQueue.sendNow(conversation.id, item.id);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to send the queued message');
		} finally {
			queueActing = false;
		}
	}

	/** Takes a queued message back into the composer, attachments included. */
	async function editQueued(item: QueuedMessage) {
		if (queueActing) return;
		queueActing = true;
		try {
			const removed = await messageQueue.remove(conversation.id, item.id);
			if (!removed) return;
			input = input.trim() ? `${input.trimEnd()}\n${removed.text}` : removed.text;
			if (removed.files.length === 0) return;
			const files = await Promise.all(
				removed.files.map(async (f) => {
					const res = await fetch(f.url);
					if (!res.ok) throw new Error(`Failed to load ${f.filename}`);
					return new File([await res.blob()], f.filename, { type: f.mediaType });
				})
			);
			addFiles(files);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to edit the queued message');
		} finally {
			queueActing = false;
		}
	}

	// Stops the response being received so a new message can take over. The Chat
	// can't start a request until the aborted one has settled. The server aborts
	// its side when the new message arrives; calling the abort endpoint here could
	// reach it after that message and kill the new response instead.
	async function interruptResponse() {
		cancelResumeRetry();
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
		cancelResumeRetry();
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
	/** The next send answers a waiting agent or task rather than starting a turn. */
	const sendAnswers = $derived(
		!editing && (!!agentQuestion || (!!codingAnswerTarget && selectedFiles.length === 0))
	);
	// A failed or interrupted coding task: the empty composer's send button retries or continues it.
	const recovery = $derived(coding && !editing && !canSend ? recoveryAction(coding) : null);

	// A dispatched chat opens with the run's instructions, written by Chatty: only
	// known to be that message once the conversation's first page is loaded.
	const dispatchMessageId = $derived(
		dispatch && !hasOlder ? (chat.messages.find((m) => m.role === 'user')?.id ?? null) : null
	);

	// Marks on the side rail for jumping between the user's own messages.
	const navItems = $derived(
		chat.messages
			.filter((m) => m.role === 'user' && m.id !== dispatchMessageId && hasVisibleContent(m.parts))
			.map((m) => ({ id: m.id, text: messageText(m) }))
	);

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
				if (voice.active) {
					voice.stop();
					return true;
				}
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

	// The command palette's entries for what this view owns (the ⋯ menu adds the rest).
	onMount(() =>
		registerCommands(() => [
			...(streaming
				? [
						{
							id: 'chat:stop',
							label: 'Stop the reply',
							group: 'This chat' as const,
							icon: SquareIcon,
							keywords: ['cancel', 'abort'],
							shortcut: 'escape' as const,
							run: stop
						}
					]
				: []),
			...(voice.active
				? [
						{
							id: 'chat:voice',
							label: 'End voice mode',
							group: 'This chat' as const,
							icon: AudioLinesIcon,
							shortcut: 'escape' as const,
							run: () => voice.stop()
						}
					]
				: voiceSupported && !isCoding && !editing && !sending && !dictating
					? [
							{
								id: 'chat:voice',
								label: 'Start voice mode',
								group: 'This chat' as const,
								icon: AudioLinesIcon,
								keywords: ['talk', 'speak', 'microphone'],
								run: startVoice
							}
						]
					: [])
		])
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
		{codingEnvironments}
		{codingAgents}
		handoffDisabled={streaming || chat.messages.length === 0}
		messageCount={chat.messages.length}
		{privateData}
		contextUsage={isCoding ? null : contextUsage}
		onupdated={(updated) => {
			conversation = updated;
		}}
	/>

	<!-- Reserve the scrollbar on both sides so messages stay centred over the composer. -->
	<div class="@container/chat relative flex min-h-0 flex-1 flex-col">
		<ChatContainer
			bind:context={scroll}
			bind:ref={scrollEl}
			resize={followAnimation}
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
					{dispatch}
					{dispatchMessageId}
					speech={playback}
				/>
				{#if waiting}
					<ThinkingIndicator since={waitingSince} class="mx-auto w-full max-w-3xl px-4 pb-4" />
				{:else if backgroundWaiting}
					<WaitingIndicator class="mx-auto w-full max-w-3xl px-4 pb-4" />
				{/if}
			</ChatContainerContent>
		</ChatContainer>
		<!-- Beside the centred column, only when the chat pane (not the window) leaves room for it. -->
		<MessageNav
			items={navItems}
			{scrollEl}
			onjump={() => scroll?.stopScroll()}
			class="left-[max(0.5rem,calc(50%-26.75rem))] hidden @4xl/chat:block"
		/>
	</div>
	<div role="status" class="sr-only">{replyAnnouncement}</div>
	<div class="sr-only" aria-live="polite">{voiceAnnouncement}</div>

	<div class="relative mx-auto w-full max-w-3xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
		{#if showJumpToLatest}
			<Button
				variant="outline"
				size="icon"
				class="absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 rounded-full bg-background shadow-md hover:bg-muted dark:bg-background dark:hover:bg-muted"
				title="Jump to latest"
				onclick={() => scroll?.scrollToBottom({ animation: 'smooth' })}
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
		<!-- Mounted before any request shows up, so screen readers announce it. -->
		<span class="sr-only" aria-live="polite">{pendingAnnouncement.polite}</span>
		<span class="sr-only" aria-live="assertive">{pendingAnnouncement.assertive}</span>
		{#if coding?.pendingRequest}
			{#key coding.pendingRequest.requestId}
				<CodingPendingRequest
					conversationId={conversation.id}
					request={coding.pendingRequest}
					onresponded={() => void refreshCoding().catch(() => undefined)}
				/>
			{/key}
		{:else if agentQuestion}
			{#key agentQuestion.request.requestId}
				<CodingPendingRequest
					conversationId={conversation.id}
					request={agentQuestion.request}
					onrespond={answerQuestion}
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
				disabled={sending || queueActing}
				onsendnow={(item) => void sendQueuedNow(item)}
				onedit={(item) => void editQueued(item)}
				onremove={(item) => void messageQueue.remove(conversation.id, item.id)}
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
		{#if voice.active || voice.phase === 'starting'}
			<VoiceBar {voice} />
		{:else}
			<PromptInput
				class="launch-composer"
				value={displayInput}
				onValueChange={(v) => (input = v)}
				onSubmit={() => sendFromComposer(displayInput)}
			>
				<PendingAttachments files={selectedFiles} onremove={removeFile} />
				<PromptInputTextarea
					onkeydown={editLastOnArrowUp}
					placeholder={editing
						? 'Edit your message…'
						: codingAnswerTarget?.kind === 'approval'
							? 'Or decline with a note…'
							: agentQuestion || codingAnswerTarget
								? 'Type your answer…'
								: streaming
									? 'Queue a follow-up message…'
									: 'Ask anything…'}
				/>
				<PromptInputActions class="justify-between">
					<div class="flex items-center gap-1">
						<Button variant="ghost" size="icon" aria-label="Attach files" onclick={pickFiles}>
							<PaperclipIcon class="size-4" />
						</Button>
						<MicButton {speech} blockedReason={micBlocked} />
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
					{:else if recovery}
						<Button
							size="sm"
							disabled={sending}
							title={recovery.hint}
							aria-label="{recovery.label}: {recovery.hint}"
							onclick={() => recoverCodingTask(recovery)}
						>
							<RotateCcwIcon class="size-4" />
							{recovery.label}
						</Button>
					{:else if voiceSupported && !isCoding && !canSend && !editing && !sending && !dictating}
						<!-- An empty composer offers voice mode where Send would be (Send needs text anyway). -->
						<VoiceModeButton onclick={startVoice} />
					{:else if dictating && !canSend}
						<!-- Nothing to send yet: the recording pill is the action while dictating. -->
						{#if voiceSupported && !isCoding && !editing}
							<VoiceModeButton blockedReason="Finish dictating first" onclick={startVoice} />
						{/if}
					{:else}
						<!-- A waiting task keeps its stream open, but an answer goes out right away. -->
						{@const queues = (streaming || sending) && !editing && !sendAnswers}
						<Button
							size="sm"
							disabled={!canSend}
							aria-label={queues ? 'Queue message' : sendAnswers ? 'Send answer' : 'Send'}
							title={queues ? 'Queue — sends when the reply finishes' : undefined}
							onclick={() => sendFromComposer(displayInput)}
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
			{#if isPrivate}
				<!-- Stays in view under the composer, like the new-chat page's note. -->
				<p
					class="mx-auto mt-1.5 flex max-w-full items-start justify-center gap-1.5 text-xs text-muted-foreground"
				>
					<LockIcon
						class="mt-0.5 size-3 shrink-0 text-emerald-600 dark:text-emerald-400"
						aria-hidden="true"
					/>
					<span>{PRIVATE_CHAT_HINT}</span>
				</p>
			{/if}
		{/if}
		<input
			bind:this={fileInput}
			type="file"
			multiple
			accept="image/*,audio/*,application/pdf,.txt,.md,.csv,.json,.xml,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip"
			class="hidden"
			onchange={filesChosen}
		/>
	</div>
</div>
