<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import {
		PromptInput,
		PromptInputTextarea,
		PromptInputActions
	} from '$lib/components/ai/prompt-input/index.js';
	import { PromptSuggestion } from '$lib/components/ai/prompt-suggestion/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import CodeIcon from '@lucide/svelte/icons/code';
	import InfoIcon from '@lucide/svelte/icons/info';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import PendingAttachments from '$lib/components/app/PendingAttachments.svelte';
	import ModelPicker from '$lib/components/app/ModelPicker.svelte';
	import CodingModelSelect from '$lib/components/app/CodingModelSelect.svelte';
	import CodingContextBar from '$lib/components/app/CodingContextBar.svelte';
	import { CodingTaskState, type CodingTaskDraft } from '$lib/state/coding-task.svelte.js';
	import MicButton from '$lib/components/app/MicButton.svelte';
	import { createSpeechRecognition } from '$lib/state/speech-recognition.svelte.js';
	import { createServerSpeechRecognition } from '$lib/state/server-speech-recognition.svelte.js';
	import { decodeModelRef } from '$lib/model-ref.js';
	import { pickerModelGroups, syncModelCatalog } from '$lib/state/model-catalog.svelte.js';
	import { pendingMessage } from '$lib/state/pending-message.svelte.js';
	import { createFileDrop } from '$lib/state/file-drop.svelte.js';
	import { clipboardFiles } from '$lib/state/clipboard-files.js';
	import { DEFAULT_CODING_SUGGESTIONS, DEFAULT_SUGGESTIONS } from '$lib/user-settings.js';
	import { START_MODE_COOKIE } from '$lib/coding-environments.js';
	import { sharedDraft, takeSharedFiles } from '$lib/share-target.js';
	import { onLaunchFiles } from '$lib/launch-files.js';
	import type { Conversation } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let input = $state('');
	const speech = data.sttModel
		? createServerSpeechRecognition(data.sttModel)
		: createSpeechRecognition();
	const displayInput = $derived(speech.recording ? (input + ' ' + speech.display).trim() : input);

	$effect(() => {
		if (!speech.recording && speech.finalTranscript) {
			input = (input + ' ' + speech.finalTranscript).trim();
			speech.reset();
		}
	});

	$effect(() => () => speech.destroy());
	let busy = $state(false);
	let picked = $state('');
	let personaId = $state('');
	let selectedFiles = $state<File[]>([]);
	let fileInput: HTMLInputElement | undefined = $state();
	let mode = $state<'chat' | 'coding'>(untrack(() => data.startMode));
	const coding = $derived(mode === 'coding' && data.codingEnvironments.length > 0);
	const codingTask = new CodingTaskState(untrack(() => data.codingEnvironments));
	const codingDraft = $derived(codingTask.draft);
	let codingStarted = false;

	// Starting a coding task is heavier than a chat message, so these fill the
	// input for review instead of sending right away.
	const codingSuggestions = $derived(
		data.codingSuggestions.length > 0 ? data.codingSuggestions : DEFAULT_CODING_SUGGESTIONS
	);

	function focusPrompt(): HTMLTextAreaElement | null {
		const textarea = document.querySelector<HTMLTextAreaElement>(
			'[role=region][aria-label="New chat"] textarea'
		);
		textarea?.focus();
		return textarea;
	}

	// Ready to type on arrival. Desktop (fine pointer) only, so phones and
	// tablets don't get the on-screen keyboard thrown up on every new chat.
	afterNavigate(() => {
		if (window.matchMedia('(pointer: fine)').matches) focusPrompt();
	});

	function useSuggestion(text: string) {
		input = text;
		const textarea = focusPrompt();
		// Caret at the end so the user can keep typing details.
		requestAnimationFrame(() => textarea?.setSelectionRange(text.length, text.length));
	}

	// Problems the bar itself doesn't already show (loading, errors, no projects).
	const codingHint = $derived(
		coding &&
			!codingTask.optionsLoading &&
			!codingTask.optionsError &&
			!codingTask.branchesLoading &&
			(codingTask.options?.projects.length ?? 0) > 0
			? codingTask.blocker
			: null
	);

	const fullAccess = $derived(
		coding && codingTask.options !== null && codingTask.autonomy === 'full-access'
	);

	function setMode(next: 'chat' | 'coding') {
		mode = next;
		// Read by the page load so the next visit opens in the same mode (no flash).
		document.cookie = `${START_MODE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
	}

	// Connect to the coding environment only once coding mode is actually used.
	$effect(() => {
		if (coding && !codingStarted) {
			codingStarted = true;
			codingTask.init();
		}
	});

	$effect(() => {
		if (page.url.searchParams.get('error') === 'conversation-not-found') {
			toast.error('Conversation not found');
			goto(resolve('/'), { replaceState: true });
		}
	});

	// App icon shortcuts (`?mode=`) and shares from other apps (share target),
	// both from the manifest in vite.config.ts. Applied once, then dropped from
	// the URL so a reload doesn't repeat them.
	$effect(() => {
		const params = page.url.searchParams;
		const startMode = params.get('mode');
		const shared = sharedDraft(params);
		const withFiles = params.has('share_files');
		if (startMode === null && shared === null) return;
		untrack(() => {
			if (startMode === 'chat' || startMode === 'coding') setMode(startMode);
			if (shared !== null) {
				setMode('chat');
				if (shared) useSuggestion(shared);
			}
		});
		if (withFiles) {
			takeSharedFiles()
				.then((files) => {
					if (files.length > 0) addIncomingFiles(files);
					else toast.error('The shared files could not be attached');
				})
				.catch(() => toast.error('The shared files could not be attached'));
		}
		goto(resolve('/'), { replaceState: true, keepFocus: true, noScroll: true });
	});

	/** Files from outside (a share, "Open with Chatty"): attached to a new chat. */
	function addIncomingFiles(files: File[]) {
		setMode('chat');
		selectedFiles = [...selectedFiles, ...files];
		focusPrompt();
	}

	onMount(() => onLaunchFiles(addIncomingFiles));

	const fileDrop = createFileDrop((files) => {
		selectedFiles = [...selectedFiles, ...files];
	});

	// Ctrl+V with a copied file or image attaches it, like dropping it would.
	function pasteFiles(e: ClipboardEvent) {
		const files = clipboardFiles(e.clipboardData);
		if (files.length === 0) return;
		e.preventDefault();
		selectedFiles = [...selectedFiles, ...files];
	}

	function pickFiles() {
		fileInput?.click();
	}

	function filesChosen(e: Event) {
		const target = e.currentTarget as HTMLInputElement;
		selectedFiles = [...selectedFiles, ...Array.from(target.files ?? [])];
		target.value = '';
	}

	const defaultModelValue = $derived(
		data.defaultModel ? `${data.defaultModel.providerId}/${data.defaultModel.modelId}` : ''
	);
	const selectedValue = $derived(picked || defaultModelValue);
	const modelGroups = $derived(pickerModelGroups(data.modelCatalog));
	$effect.pre(() => syncModelCatalog(data.modelCatalog));
	const hasModels = $derived(data.modelCatalog.count > 0);
	const modelMissing = $derived(!hasModels || selectedValue === '');
	const canSend = $derived(
		coding
			? displayInput.trim().length > 0 && !busy && codingDraft !== null
			: (displayInput.trim().length > 0 || selectedFiles.length > 0) && !busy && !modelMissing
	);
	const suggestions = $derived(
		data.suggestions.length > 0 ? data.suggestions : DEFAULT_SUGGESTIONS
	);
	const personaLabel = $derived(
		personaId === '' ? 'I' : (data.personas.find((p) => p.id === personaId)?.name ?? 'I')
	);

	let latestNavigation: string | undefined;
	beforeNavigate(({ to }) => {
		latestNavigation = to?.url.pathname;
	});

	async function createChatConversation(): Promise<Conversation> {
		const body: Record<string, string> = {};
		if (selectedValue) {
			const { providerId, modelId } = decodeModelRef(selectedValue);
			body.providerId = providerId;
			body.modelId = modelId;
		}
		if (personaId) body.agentId = personaId;
		const res = await fetch('/api/conversations', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error('Failed to create conversation');
		const { conversation } = (await res.json()) as { conversation: Conversation };
		return conversation;
	}

	// The task itself starts when ChatView sends the first message.
	async function createCodingTask(draft: CodingTaskDraft): Promise<Conversation> {
		const res = await fetch('/api/coding/tasks', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(draft)
		});
		if (!res.ok) {
			const data = (await res.json().catch(() => null)) as { message?: string } | null;
			throw new Error(data?.message ?? 'Failed to create coding task');
		}
		const { conversation } = (await res.json()) as { conversation: Conversation };
		return conversation;
	}

	async function startChat(text: string) {
		speech.stop();
		speech.reset();
		const trimmed = text.trim();
		const draft = coding ? codingDraft : null;
		if (coding ? !trimmed || !draft : (!trimmed && selectedFiles.length === 0) || modelMissing)
			return;
		if (busy) return;
		busy = true;
		try {
			const conversation = draft ? await createCodingTask(draft) : await createChatConversation();
			pendingMessage.set(conversation.id, trimmed, selectedFiles);
			const target = resolve(`/chat/${conversation.id}`);
			await goto(target);
			// goto() also resolves when the navigation was cancelled. Unless the user
			// has since gone elsewhere, hand the input back rather than staying stuck.
			if (page.url.pathname !== target && latestNavigation === target) {
				throw new Error('Could not open the new chat, please try again');
			}
		} catch (e) {
			pendingMessage.clear();
			toast.error(e instanceof Error ? e.message : 'Failed to start chat');
			busy = false;
		}
	}
</script>

<div
	class="relative flex flex-1 flex-col items-center justify-center gap-8 p-6"
	role="region"
	aria-label="New chat"
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
	<div class="flex flex-col items-center gap-5">
		{#if data.codingEnvironments.length > 0}
			<Tabs.Root value={mode} onValueChange={(v) => setMode(v as 'chat' | 'coding')}>
				<Tabs.List aria-label="What to start">
					<Tabs.Trigger value="chat" class="px-3" disabled={busy}>
						<MessageCircleIcon />
						Chat
					</Tabs.Trigger>
					<Tabs.Trigger value="coding" class="px-3" disabled={busy}>
						<CodeIcon />
						Code
					</Tabs.Trigger>
				</Tabs.List>
			</Tabs.Root>
		{/if}
		{#if coding}
			<h1 class="text-center text-2xl font-semibold">What are we working on?</h1>
		{:else if data.personas.length > 0}
			<h1 class="flex flex-wrap items-center justify-center gap-x-2 text-2xl font-semibold">
				What can
				<Select.Root type="single" bind:value={personaId} disabled={busy}>
					<Select.Trigger
						class="h-auto! w-auto gap-1 rounded-lg border-none bg-transparent p-0 text-2xl font-semibold underline decoration-muted-foreground/50 underline-offset-8 shadow-none hover:bg-transparent focus-visible:ring-0 [&_svg]:hidden"
					>
						{personaLabel}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="">I (default)</Select.Item>
						{#each data.personas as persona (persona.id)}
							<Select.Item value={persona.id}>{persona.name}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				help you with?
			</h1>
		{:else}
			<h1 class="text-2xl font-semibold">What can I help you with?</h1>
		{/if}
	</div>
	<div class="w-full max-w-2xl">
		<PromptInput
			value={displayInput}
			onValueChange={(v) => (input = v)}
			onSubmit={() => startChat(displayInput)}
		>
			<PendingAttachments
				files={selectedFiles}
				onremove={(file) => (selectedFiles = selectedFiles.filter((f) => f !== file))}
			/>
			<PromptInputTextarea
				placeholder={coding
					? `Describe a task for ${codingTask.project?.title ?? 'the coding agent'}…`
					: 'Ask anything…'}
			/>
			<PromptInputActions class="justify-between">
				<!-- min-w-0 lets the model picker give way on narrow phones instead of pushing Send out. -->
				<div class="flex min-w-0 items-center gap-1">
					{#if coding}
						<CodingModelSelect state={codingTask} disabled={busy} shortcut />
						<Button variant="ghost" size="icon" aria-label="Attach files" onclick={pickFiles}>
							<PaperclipIcon class="size-4" />
						</Button>
					{:else}
						<ModelPicker
							groups={modelGroups}
							mappings={data.mappings}
							value={selectedValue}
							onselect={(v) => (picked = v)}
							disabled={busy}
							class="w-40 min-w-0 shrink max-sm:w-auto max-sm:max-w-40 sm:w-64 max-sm:[&_[data-model-source]]:hidden"
						/>
						<Button variant="ghost" size="icon" aria-label="Attach files" onclick={pickFiles}>
							<PaperclipIcon class="size-4" />
						</Button>
					{/if}
					<MicButton {speech} />
				</div>
				<Button
					size="sm"
					aria-label="Send"
					disabled={!canSend}
					title={coding
						? (codingTask.blocker ?? 'Start coding task')
						: modelMissing
							? 'Select a model first'
							: 'Send'}
					onclick={() => startChat(displayInput)}
				>
					<ArrowUpIcon class="size-4" />
				</Button>
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
		{#if modelMissing && !coding}
			<p class="mt-2 text-sm text-muted-foreground">
				{hasModels
					? 'Select a model to start chatting.'
					: 'No models available. Ask an admin to configure one.'}
			</p>
		{/if}
		{#if coding}
			<div class="relative mt-3">
				<CodingContextBar state={codingTask} disabled={busy} oncreated={focusPrompt} />
				<!-- Always mounted so screen readers announce the first hint too. Positioned
				     in the gap below so showing or hiding it never moves the suggestions. -->
				<p
					class={[
						'absolute inset-x-0 top-full mt-1 flex items-center gap-1.5 px-1 text-sm',
						codingHint ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400'
					]}
					aria-live="polite"
				>
					{#if codingHint}
						<InfoIcon class="size-4 shrink-0" />
						<span class="truncate" title={codingHint}>{codingHint}</span>
					{:else if fullAccess}
						<ShieldAlertIcon class="size-4 shrink-0" />
						<span class="truncate">Full access: the agent won't ask before acting.</span>
					{/if}
				</p>
			</div>
		{/if}
	</div>
	{#if coding}
		{#if codingTask.project}
			<div class="mt-2 flex max-w-2xl flex-wrap justify-center gap-2">
				{#each codingSuggestions as suggestion (suggestion)}
					<PromptSuggestion onclick={() => useSuggestion(suggestion)}>{suggestion}</PromptSuggestion
					>
				{/each}
			</div>
		{/if}
	{:else}
		<div class="flex max-w-2xl flex-wrap justify-center gap-2">
			{#each suggestions as suggestion (suggestion)}
				<PromptSuggestion onclick={() => startChat(suggestion)}>{suggestion}</PromptSuggestion>
			{/each}
		</div>
	{/if}
</div>
