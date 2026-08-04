<script lang="ts">
	import { invalidateAll } from '$app/navigation';
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
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import FileIcon from '@lucide/svelte/icons/file';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import XIcon from '@lucide/svelte/icons/x';
	import ChatTopbar from './ChatTopbar.svelte';
	import MessageTimeline from './MessageTimeline.svelte';
	import { activeChats } from '$lib/state/active-chats.svelte.js';
	import { onServerEvent, onServerEventResync } from '$lib/state/events.svelte.js';
	import { pendingMessage } from '$lib/state/pending-message.svelte.js';
	import { createFileDrop } from '$lib/state/file-drop.svelte.js';
	import MicButton from '$lib/components/app/MicButton.svelte';
	import { createSpeechRecognition } from '$lib/state/speech-recognition.svelte.js';
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

	let {
		conversation: initialConversation,
		initialMessages,
		groups,
		mappings = [],
		defaultModel,
		timeFormat = 'auto',
		personas,
		initiallyGenerating = false
	}: {
		conversation: Conversation;
		initialMessages: ChatMessage[];
		groups: ModelsByProvider[];
		mappings?: ModelMapping[];
		defaultModel?: { providerId: string; modelId: string } | null;
		timeFormat?: TimeFormat;
		personas?: Agent[];
		initiallyGenerating?: boolean;
	} = $props();

	// svelte-ignore state_referenced_locally
	let conversation = $state(initialConversation);
	let input = $state('');
	const speech = createSpeechRecognition();
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
	const canSend = $derived((input.trim().length > 0 || selectedFiles.length > 0) && !streaming);

	async function markRead() {
		await fetch(`/api/conversations/${conversation.id}/read`, { method: 'POST' }).catch(
			() => undefined
		);
		await invalidateAll();
	}

	onMount(() => {
		if (remoteGenerating) {
			// A stream is (or was) running server-side. Attach to it for live tokens;
			// a 204 means it already finished, so just reload the persisted state.
			chat
				.resumeStream()
				.catch(() => undefined)
				.finally(() => {
					if (chat.status !== 'streaming' && chat.status !== 'submitted') {
						remoteGenerating = false;
						void invalidateAll();
					}
				});
		} else {
			markRead();
		}
	});

	$effect(() => {
		const pending = pendingMessage.consume();
		if (!pending) return;
		if (pending.files.length > 0) addFiles(pending.files);
		send(pending.text);
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
			await invalidateAll();
			await tick();
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

	$effect(() => {
		const current = chat.status;
		if (prevStatus !== 'ready' && current === 'ready') {
			markRead();
			if (activeChats.get(conversation.id) === chat) {
				activeChats.delete(conversation.id);
			}
		}
		prevStatus = current;
	});

	async function uploadFiles(): Promise<
		{ type: 'file'; url: string; mediaType: string; filename: string }[]
	> {
		const parts = [];
		for (const file of selectedFiles) {
			const form = new FormData();
			form.append('file', file);
			const res = await fetch(`/api/conversations/${conversation.id}/attachments`, {
				method: 'POST',
				body: form
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message ?? `Failed to upload ${file.name}`);
			}
			const { attachment } = await res.json();
			parts.push({
				type: 'file' as const,
				url: `/api/conversations/${conversation.id}/attachments/${attachment.id}`,
				mediaType: attachment.mime,
				filename: attachment.name
			});
		}
		return parts;
	}

	const SKILL_CMD = /^\/skill\s+([a-z0-9][a-z0-9-]{0,63})\s*/i;

	async function send(text: string) {
		speech.stop();
		speech.reset();
		let trimmed = text.trim();
		if ((!trimmed && selectedFiles.length === 0) || streaming) return;
		let skill: string | undefined;
		const skillMatch = trimmed.match(SKILL_CMD);
		if (skillMatch) {
			skill = skillMatch[1];
			trimmed = trimmed.slice(skillMatch[0].length).trim();
			if (!trimmed) trimmed = `Use the ${skill} skill.`;
		}
		try {
			const body = skill ? { body: { skill } } : undefined;
			if (selectedFiles.length > 0) {
				const fileParts = await uploadFiles();
				clearFiles();
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
			input = '';
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to send message');
		}
	}

	async function stop() {
		fetch(`/api/chat/${conversation.id}/abort`, { method: 'POST' }).catch(() => undefined);
		await chat.stop();
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
	ondragenter={fileDrop.ondragenter}
	ondragover={fileDrop.ondragover}
	ondragleave={fileDrop.ondragleave}
	ondrop={fileDrop.ondrop}
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
		onupdated={(updated) => (conversation = updated)}
	/>

	<ChatContainer class="min-h-0 flex-1">
		<ChatContainerContent>
			<MessageTimeline
				messages={chat.messages}
				{streaming}
				{timeFormat}
				{messageTimes}
				onregenerate={regenerate}
				onedit={startEdit}
			/>
			{#if waiting}
				<div
					class="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 pb-4 text-muted-foreground"
				>
					<span class="thinking-dots" aria-hidden="true">
						<span class="thinking-dot"></span>
						<span class="thinking-dot"></span>
						<span class="thinking-dot"></span>
					</span>
					<span class="text-sm">Thinking…</span>
				</div>
			{/if}
		</ChatContainerContent>
	</ChatContainer>

	<div class="mx-auto w-full max-w-3xl px-4 pb-4">
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
		<PromptInput
			value={displayInput}
			onValueChange={(v) => (input = v)}
			isLoading={streaming}
			onSubmit={() => send(displayInput)}
		>
			<PromptInputTextarea placeholder="Ask anything…" />
			<PromptInputActions class="justify-between">
				<div class="flex items-center gap-1">
					<Button variant="ghost" size="icon" aria-label="Attach files" onclick={pickFiles}>
						<PaperclipIcon class="size-4" />
					</Button>
					<MicButton {speech} />
				</div>
				{#if streaming}
					<Button size="sm" variant="destructive" aria-label="Stop" onclick={stop}>
						<SquareIcon class="size-4" />
					</Button>
				{:else}
					<Button size="sm" disabled={!canSend} aria-label="Send" onclick={() => send(input)}>
						<ArrowUpIcon class="size-4" />
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

<style>
	.thinking-dots {
		display: inline-flex;
		align-items: center;
		gap: 3px;
	}

	.thinking-dot {
		width: 5px;
		height: 5px;
		border-radius: 9999px;
		background-color: currentColor;
		animation: thinking-bounce 1.2s ease-in-out infinite;
	}

	.thinking-dot:nth-child(2) {
		animation-delay: 0.15s;
	}

	.thinking-dot:nth-child(3) {
		animation-delay: 0.3s;
	}

	@keyframes thinking-bounce {
		0%,
		100% {
			transform: translateY(0);
			opacity: 0.4;
		}
		50% {
			transform: translateY(-3px);
			opacity: 1;
		}
	}
</style>
