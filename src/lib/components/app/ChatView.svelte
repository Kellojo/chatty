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
	import { Badge } from '$lib/components/ui/badge/index.js';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import SquareIcon from '@lucide/svelte/icons/square';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
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
				prepareSendMessagesRequest: ({ messages }) => ({
					body: { conversationId: conversation.id, messages }
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
		if (!remoteGenerating) markRead();
	});

	$effect(() => {
		const pending = pendingMessage.consume();
		if (!pending) return;
		if (pending.files.length > 0) selectedFiles = [...selectedFiles, ...pending.files];
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
				selectedFiles = [];
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
		input = text;
	}

	const fileDrop = createFileDrop((files) => {
		selectedFiles = [...selectedFiles, ...files];
	});

	function pickFiles() {
		fileInput?.click();
	}

	function filesChosen(e: Event) {
		const target = e.currentTarget as HTMLInputElement;
		selectedFiles = [...selectedFiles, ...Array.from(target.files ?? [])];
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
					<Badge variant="secondary" class="flex items-center gap-1">
						{file.name}
						<button
							aria-label="Remove {file.name}"
							onclick={() => (selectedFiles = selectedFiles.filter((_, j) => j !== i))}
						>
							<XIcon class="size-3" />
						</button>
					</Badge>
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
