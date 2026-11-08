<script lang="ts">
	import { Chat } from '@ai-sdk/svelte';
	import { DefaultChatTransport } from 'ai';
	import { onMount, tick, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { toast } from 'svelte-sonner';
	import { ChatContainer, ChatContainerContent } from '$lib/components/ai/chat-container/index.js';
	import {
		PromptInput,
		PromptInputTextarea,
		PromptInputActions
	} from '$lib/components/ai/prompt-input/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import SquareIcon from '@lucide/svelte/icons/square';
	import ListEndIcon from '@lucide/svelte/icons/list-end';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import FileIcon from '@lucide/svelte/icons/file';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import XIcon from '@lucide/svelte/icons/x';
	import ChatTopbar from './ChatTopbar.svelte';
	import CodingPendingRequest from './CodingPendingRequest.svelte';
	import MessageTimeline from './MessageTimeline.svelte';
	import ThinkingIndicator from './ThinkingIndicator.svelte';
	import { activeChats } from '$lib/state/active-chats.svelte.js';
	import { createPullRequestPrompt } from '$lib/coding-task-details.js';
	import { onServerEvent, onServerEventResync } from '$lib/state/events.svelte.js';
	import { invalidateWhenIdle } from '$lib/state/invalidate-when-idle.js';
	import { pendingMessage } from '$lib/state/pending-message.svelte.js';
	import { messageQueue, type QueuedMessage } from '$lib/state/message-queue.svelte.js';
	import QueuedMessages from './QueuedMessages.svelte';
	import { parseSkillCommand, uploadAttachments } from '$lib/chat-send.js';
	import { createFileDrop } from '$lib/state/file-drop.svelte.js';
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
		type UIMessage
	} from '$lib/types.js';
	import type { TimeFormat } from '$lib/user-settings.js';
	import type { CodingConversation, CodingEnvironment } from '$lib/coding-environments.js';

	let {
		conversation: initialConversation,
		initialMessages,
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
		initialMessages: ChatMessage[];
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
	let input = $state('');
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
						// remaining message is the user message to regenerate from
						const message = messages[messages.length - 1];
						return {
							body: { conversationId: conversation.id, message, truncateFrom: messageId }
						};
					}
					const message = messages[messages.length - 1];
					const truncateFrom = pendingTruncateFrom;
					pendingTruncateFrom = undefined;
					return {
						body: {
							conversationId: conversation.id,
							message,
							...(truncateFrom ? { truncateFrom } : {})
						}
					};
				},
				prepareReconnectToStreamRequest: () => ({
					api: `/api/chat/${conversation.id}/stream`
				})
			}),
			onError: (error) => {
				toast.error(error.message || 'Something went wrong');
			}
		});
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
	let pendingTruncateFrom = $state<string | undefined>(undefined);

	const reusedLocal = activeChats.has(untrack(() => conversation.id));
	// svelte-ignore state_referenced_locally
	let remoteGenerating = $state(initiallyGenerating && !reusedLocal);

	let prevStatus = $state<string>(chat.status);

	// svelte-ignore state_referenced_locally
	const messageTimes = new SvelteMap<string, number>(
		initialMessages.map((m) => [m.id, m.createdAt])
	);

	const streaming = $derived(
		chat.status === 'streaming' || chat.status === 'submitted' || remoteGenerating
	);
	const lastAssistant = $derived(chat.messages.findLast((m) => m.role === 'assistant'));
	const waiting = $derived(
		remoteGenerating ||
			chat.status === 'submitted' ||
			(chat.status === 'streaming' &&
				(!lastAssistant ||
					lastAssistant.parts.length === 0 ||
					lastAssistant.parts.every((p) =>
						p.type === 'text' || p.type === 'reasoning' ? p.text === '' : false
					)))
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
	let sending = $state(false);

	async function markRead() {
		await fetch(`/api/conversations/${conversation.id}/read`, { method: 'POST' }).catch(
			() => undefined
		);
		await invalidateWhenIdle();
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
			void (async () => {
				remoteGenerating = true;
				// Pick up the user message that started the turn before attaching.
				await invalidateWhenIdle();
				await tick();
				if (!remoteGenerating || localBusy() || conversation.id !== id) return;
				chat.messages = initialMessages.map(chatMessageToUIMessage);
				resumeRemoteStream();
			})();
		});
	});

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
			chat.messages = initialMessages.map(chatMessageToUIMessage);
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
			chat.messages = initialMessages.map(chatMessageToUIMessage);
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
		chat.messages = initialMessages.map(chatMessageToUIMessage);
	}

	$effect(() => {
		const current = chat.status;
		if (prevStatus !== 'error' && current === 'error') {
			messageQueue.pause(conversation.id);
			void reloadAfterError(conversation.id);
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

	/** Interrupts any running reply and sends the message. Returns false on failure. */
	async function deliver(text: string, files: File[]): Promise<boolean> {
		if (sending) return false;
		sending = true;
		const { text: trimmed, skill } = parseSkillCommand(text);
		try {
			const body = skill ? { body: { skill } } : undefined;
			if (files.length > 0) {
				// Upload first: if this fails the running response is left untouched.
				const fileParts = await uploadAttachments(conversation.id, files);
				await interruptResponse();
				chat.sendMessage(
					{
						parts: [...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []), ...fileParts]
					},
					body
				);
			} else {
				await interruptResponse();
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

	/** Sends a predefined instruction to the coding agent without touching the draft. */
	async function createPullRequest() {
		if (!coding || sending) return;
		sending = true;
		try {
			await interruptResponse();
			chat.sendMessage({ text: createPullRequestPrompt(coding) });
			activeChats.set(conversation.id, chat);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to send message');
		} finally {
			sending = false;
		}
	}

	function regenerate(messageId: string) {
		chat.regenerate({ messageId });
		activeChats.set(conversation.id, chat);
	}

	function startEdit(messageId: string, text: string) {
		const index = chat.messages.findIndex((m) => m.id === messageId);
		if (index === -1) return;
		chat.messages = chat.messages.slice(0, index);
		pendingTruncateFrom = messageId;
		input = text;
	}

	const fileDrop = createFileDrop((files) => {
		addFiles(files);
	});

	// Navigating away destroys this view (the page uses {#key}); make sure the
	// sidebar indicator doesn't keep spinning for a chat we're no longer showing.
	onMount(() => {
		const id = conversation.id;
		return () => {
			if (activeChats.get(id) === chat) {
				activeChats.delete(id);
			}
		};
	});

	// Object URLs for pending image previews, kept in a plain map (not reactive —
	// entries are added/removed alongside every selectedFiles mutation below).
	const previewUrls = new SvelteMap<File, string>();
	function previewUrl(file: File): string | undefined {
		return previewUrls.get(file);
	}

	const TEXT_TYPES = new Set(['application/json', 'application/xml']);
	const TEXT_EXT = /\.(txt|md|markdown|csv|json|xml|log|ya?ml|toml)$/i;
	const TEXT_PREVIEW_LEN = 300;
	function isTextFile(file: File): boolean {
		return file.type.startsWith('text/') || TEXT_TYPES.has(file.type) || TEXT_EXT.test(file.name);
	}

	// Snippets for pending text files, read async on add; plain map keyed by File.
	const textPreviews = new SvelteMap<File, string>();
	let textPreviewVersion = $state(0);
	function textPreview(file: File): string | undefined {
		void textPreviewVersion;
		return textPreviews.get(file);
	}

	function addFiles(files: File[]) {
		for (const f of files) {
			if (f.type.startsWith('image/') && !previewUrls.has(f)) {
				previewUrls.set(f, URL.createObjectURL(f));
			} else if (isTextFile(f) && !textPreviews.has(f)) {
				textPreviews.set(f, '');
				void f
					.text()
					.then((t) => {
						let snippet = t.replaceAll('\r\n', '\n').trim();
						if (snippet.length > TEXT_PREVIEW_LEN)
							snippet = snippet.slice(0, TEXT_PREVIEW_LEN) + '…';
						textPreviews.set(f, snippet);
						textPreviewVersion++;
					})
					.catch(() => {
						textPreviews.delete(f);
						textPreviewVersion++;
					});
			}
		}
		selectedFiles = [...selectedFiles, ...files];
	}

	function removeFile(file: File) {
		const url = previewUrls.get(file);
		if (url) {
			URL.revokeObjectURL(url);
			previewUrls.delete(file);
		}
		textPreviews.delete(file);
		selectedFiles = selectedFiles.filter((f) => f !== file);
	}

	function clearFiles() {
		for (const url of previewUrls.values()) URL.revokeObjectURL(url);
		previewUrls.clear();
		textPreviews.clear();
		selectedFiles = [];
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	onMount(() => {
		return () => {
			for (const url of previewUrls.values()) URL.revokeObjectURL(url);
			previewUrls.clear();
			textPreviews.clear();
		};
	});

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
	class="relative flex h-full min-h-0 flex-1 flex-col"
	role="region"
	aria-label="Chat"
	ondragenter={isCoding ? undefined : fileDrop.ondragenter}
	ondragover={isCoding ? undefined : fileDrop.ondragover}
	ondragleave={isCoding ? undefined : fileDrop.ondragleave}
	ondrop={isCoding ? undefined : fileDrop.ondrop}
>
	{#if fileDrop.dragActive && !isCoding}
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
		oncreatepr={isCoding ? createPullRequest : undefined}
		{codingEnvironments}
		{codingAgents}
		handoffDisabled={streaming || chat.messages.length === 0}
		onupdated={(updated) => (conversation = updated)}
	/>

	<!-- Reserve the scrollbar on both sides so messages stay centred over the composer. -->
	<ChatContainer class="min-h-0 flex-1 [scrollbar-gutter:stable_both-edges]">
		<ChatContainerContent>
			<MessageTimeline
				messages={chat.messages}
				{streaming}
				{timeFormat}
				{messageTimes}
				conversationId={conversation.id}
				onregenerate={isCoding ? undefined : regenerate}
				onedit={isCoding ? undefined : startEdit}
			/>
			{#if waiting}
				<ThinkingIndicator since={waitingSince} class="mx-auto w-full max-w-3xl px-4 pb-4" />
			{/if}
		</ChatContainerContent>
	</ChatContainer>

	<div class="mx-auto w-full max-w-3xl px-4 pb-4">
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
		{#if selectedFiles.length > 0}
			<div class="mb-2 flex flex-wrap gap-2">
				{#each selectedFiles as file, i (file.name + i)}
					{@const snippet = textPreview(file)}
					<div class="relative w-40">
						{#if file.type.startsWith('image/')}
							<img
								src={previewUrl(file)}
								alt={file.name}
								class="max-h-24 w-full rounded-md border object-cover"
							/>
						{:else if isTextFile(file)}
							<div
								class="flex h-24 flex-col overflow-hidden rounded-md border bg-muted/50 p-1.5"
								title={file.name}
							>
								{#if snippet}
									<p
										class="line-clamp-4 flex-1 text-[10px] break-all whitespace-pre-wrap text-muted-foreground"
									>
										{snippet}
									</p>
								{:else}
									<div class="flex flex-1 items-center justify-center text-muted-foreground">
										<FileTextIcon class="size-5" />
									</div>
								{/if}
							</div>
						{:else}
							<div
								class="flex h-24 flex-col items-center justify-center gap-1 rounded-md border bg-muted/50 p-1.5 text-muted-foreground"
								title={file.name}
							>
								<FileIcon class="size-6" />
								<span class="text-[10px]">{formatBytes(file.size)}</span>
							</div>
						{/if}
						<div
							class="absolute inset-x-0 bottom-0 truncate rounded-b-md bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground"
						>
							{file.name}
						</div>
						<button
							aria-label="Remove {file.name}"
							class="absolute -top-1.5 -right-1.5 rounded-full bg-muted p-0.5 hover:bg-accent"
							onclick={() => removeFile(file)}
						>
							<XIcon class="size-3" />
						</button>
					</div>
				{/each}
			</div>
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
		<PromptInput
			value={displayInput}
			onValueChange={(v) => (input = v)}
			onSubmit={() => send(displayInput)}
		>
			<PromptInputTextarea
				placeholder={streaming ? 'Queue a follow-up message…' : 'Ask anything…'}
			/>
			<PromptInputActions class="justify-between">
				<div class="flex items-center gap-1">
					{#if !isCoding}
						<Button variant="ghost" size="icon" aria-label="Attach files" onclick={pickFiles}>
							<PaperclipIcon class="size-4" />
						</Button>
					{/if}
					<MicButton {speech} />
				</div>
				{#if streaming && !hasContent}
					<Button size="sm" variant="destructive" aria-label="Stop" onclick={stop}>
						<SquareIcon class="size-4" />
					</Button>
				{:else}
					<Button
						size="sm"
						disabled={!hasContent}
						aria-label={streaming || sending ? 'Queue message' : 'Send'}
						title={streaming || sending ? 'Queue — sends when the reply finishes' : undefined}
						onclick={() => send(displayInput)}
					>
						{#if streaming || sending}
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
