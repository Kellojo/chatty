<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { PRIVATE_CHAT_HINT } from '$lib/private-data.js';
	import { afterNavigate, beforeNavigate, goto, onNavigate } from '$app/navigation';
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
	import LockIcon from '@lucide/svelte/icons/lock';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
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
	import PrivateChatToggle from '$lib/components/app/PrivateChatToggle.svelte';
	import { modelValueTrusted, trustedProviderIds } from '$lib/private-data.js';
	import {
		micAvailable,
		PRIVATE_MIC_HINT,
		voiceModeAvailable,
		type SpeechPrivacy
	} from '$lib/private-speech.js';
	import { createSpeechRecognition } from '$lib/state/speech-recognition.svelte.js';
	import { createServerSpeechRecognition } from '$lib/state/server-speech-recognition.svelte.js';
	import { decodeModelRef } from '$lib/model-ref.js';
	import { pickerModelGroups, syncModelCatalog } from '$lib/state/model-catalog.svelte.js';
	import { pendingMessage, pendingVoice } from '$lib/state/pending-message.svelte.js';
	import { voiceModeSupported } from '$lib/state/voice-mode.svelte.js';
	import { localVoiceCount } from '$lib/state/local-voices.svelte.js';
	import { unlockVoiceAudio } from '$lib/state/voice-audio.js';
	import VoiceModeButton from '$lib/components/app/VoiceModeButton.svelte';
	import { createFileDrop } from '$lib/state/file-drop.svelte.js';
	import { clipboardFiles } from '$lib/state/clipboard-files.js';
	import { DEFAULT_CODING_SUGGESTIONS, DEFAULT_SUGGESTIONS } from '$lib/user-settings.js';
	import { START_MODE_COOKIE } from '$lib/coding-environments.js';
	import { sharedDraft, takeSharedFiles } from '$lib/share-target.js';
	import { MAX_PREFILL_PROMPT_LENGTH } from '$lib/onboarding.js';
	import { onLaunchFiles } from '$lib/launch-files.js';
	import { launch, launchTransition } from '$lib/launch-transition.js';
	import type { Conversation } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let input = $state('');
	// Read when dictation is sent: an unsaved chat says whether it will be private.
	const speechPrivacy = (): SpeechPrivacy => ({ private: isPrivate });
	const speech = data.sttModel
		? createServerSpeechRecognition(data.sttModel, { privacy: speechPrivacy })
		: createSpeechRecognition({ private: () => isPrivate });
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
		// A starter prompt picked at the end of onboarding: filled in, not sent.
		const prompt = params.get('prompt')?.trim().slice(0, MAX_PREFILL_PROMPT_LENGTH) ?? null;
		if (startMode === null && shared === null && prompt === null) return;
		untrack(() => {
			if (startMode === 'chat' || startMode === 'coding') setMode(startMode);
			if (shared !== null) {
				setMode('chat');
				if (shared) useSuggestion(shared);
			}
			if (prompt && input.trim() === '') {
				setMode('chat');
				useSuggestion(prompt);
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

	// A private chat (the composer's lock): only trusted models may run it.
	// Coding tasks can never be private. Starts on with "New chats are private".
	let makePrivate = $state(untrack(() => data.settings.privateByDefault));
	const isPrivate = $derived(
		makePrivate && !coding && data.privateData.enabled && data.privateData.available
	);
	const untrustedModel = $derived(
		isPrivate &&
			!modelMissing &&
			!modelValueTrusted(selectedValue, trustedProviderIds(modelGroups), data.mappings)
	);
	const canSend = $derived(
		coding
			? displayInput.trim().length > 0 && !busy && codingDraft !== null
			: (displayInput.trim().length > 0 || selectedFiles.length > 0) &&
					!busy &&
					!modelMissing &&
					!untrustedModel
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

	// The launch into a just-created chat (armed in startChat).
	onNavigate((navigation) => {
		if (navigation.to?.route.id !== '/(app)/chat/[id]') {
			launch.disarm();
			return;
		}
		return launchTransition(navigation.complete);
	});

	async function createChatConversation(): Promise<Conversation> {
		const body: Record<string, string | boolean> = {};
		if (selectedValue) {
			const { providerId, modelId } = decodeModelRef(selectedValue);
			body.providerId = providerId;
			body.modelId = modelId;
		}
		if (personaId) body.agentId = personaId;
		// Said either way while the lock shows, so turning it off beats the
		// "New chats are private" setting the server would apply otherwise.
		if (data.privateData.enabled && data.privateData.available) body.private = isPrivate;
		const res = await fetch('/api/conversations', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			const data = (await res.json().catch(() => null)) as { message?: string } | null;
			throw new Error(data?.message ?? 'Failed to create conversation');
		}
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

	// A private chat only dictates and talks with trusted speech to text (never the browser's).
	const sttConfigured = $derived(data.sttModel !== null);
	const micBlocked = $derived(
		isPrivate &&
			!micAvailable({ isPrivate, sttTrusted: data.privateData.sttTrusted, sttConfigured })
			? PRIVATE_MIC_HINT
			: undefined
	);
	// Turned private mid-dictation: stop listening rather than keep sending audio out.
	$effect(() => {
		if (micBlocked && (speech.recording || speech.busy)) untrack(() => speech.stop());
	});
	const voiceSupported = $derived(
		voiceModeSupported(
			data.sttModel,
			data.serverTts && (!isPrivate || data.privateData.ttsTrusted),
			isPrivate
		) &&
			voiceModeAvailable({
				isPrivate,
				sttTrusted: data.privateData.sttTrusted,
				sttConfigured,
				ttsTrusted: data.privateData.ttsTrusted,
				ttsConfigured: data.serverTts,
				localVoiceCount: localVoiceCount()
			})
	);
	const offerVoice = $derived(
		voiceSupported &&
			!coding &&
			!modelMissing &&
			!untrustedModel &&
			displayInput.trim() === '' &&
			selectedFiles.length === 0 &&
			!speech.recording &&
			!speech.busy
	);

	/** Opens a new chat in voice mode. */
	async function startVoiceChat() {
		if (busy || modelMissing || untrustedModel) return;
		speech.stop();
		speech.reset();
		// Unlocked by this click, for the chat page that voice mode runs on.
		unlockVoiceAudio();
		busy = true;
		try {
			const conversation = await createChatConversation();
			pendingVoice.set(conversation.id);
			const target = resolve(`/chat/${conversation.id}`);
			await goto(target);
			if (page.url.pathname !== target && latestNavigation === target) {
				throw new Error('Could not open the new chat, please try again');
			}
		} catch (e) {
			pendingVoice.clear();
			toast.error(e instanceof Error ? e.message : 'Failed to start voice mode');
			busy = false;
		}
	}

	async function startChat(text: string) {
		speech.stop();
		speech.reset();
		const trimmed = text.trim();
		const draft = coding ? codingDraft : null;
		if (
			coding
				? !trimmed || !draft
				: (!trimmed && selectedFiles.length === 0) || modelMissing || untrustedModel
		)
			return;
		if (busy) return;
		busy = true;
		try {
			const conversation = draft ? await createCodingTask(draft) : await createChatConversation();
			pendingMessage.set(conversation.id, trimmed, selectedFiles);
			launch.arm(draft ? 'coding' : 'chat', trimmed);
			const target = resolve(`/chat/${conversation.id}`);
			await goto(target);
			// goto() also resolves when the navigation was cancelled. Unless the user
			// has since gone elsewhere, hand the input back rather than staying stuck.
			if (page.url.pathname !== target && latestNavigation === target) {
				throw new Error('Could not open the new chat, please try again');
			}
		} catch (e) {
			pendingMessage.clear();
			launch.disarm();
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
	<!-- Same width as the composer below, so center-in-viewport moves both by the same amount. -->
	<div class="flex w-full max-w-2xl center-in-viewport flex-col items-center gap-5">
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
			<h1 class="launch-title text-center text-2xl font-semibold">What are we working on?</h1>
		{:else if data.personas.length > 0}
			<h1
				class="launch-title flex flex-wrap items-center justify-center gap-x-2 text-2xl font-semibold"
			>
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
			<h1 class="launch-title text-2xl font-semibold">What can I help you with?</h1>
		{/if}
	</div>
	<div class="w-full max-w-2xl center-in-viewport">
		<PromptInput
			class="launch-composer"
			value={displayInput}
			onValueChange={(v) => (input = v)}
			onSubmit={() => startChat(displayInput)}
		>
			{#if selectedFiles.length > 0}
				<!-- Lifts off with the message when a chat starts (launch.css). -->
				<div class="launch-files">
					<PendingAttachments
						files={selectedFiles}
						onremove={(file) => (selectedFiles = selectedFiles.filter((f) => f !== file))}
					/>
				</div>
			{/if}
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
							privateOnly={isPrivate}
							class="w-40 min-w-0 shrink max-sm:w-auto max-sm:max-w-40 sm:w-64 max-sm:[&_[data-model-source]]:hidden"
						/>
						<Button variant="ghost" size="icon" aria-label="Attach files" onclick={pickFiles}>
							<PaperclipIcon class="size-4" />
						</Button>
						<PrivateChatToggle
							bind:checked={makePrivate}
							status={data.privateData}
							admin={data.user.role === 'admin'}
							disabled={busy}
						/>
					{/if}
					<MicButton {speech} blockedReason={micBlocked} />
				</div>
				{#if offerVoice}
					<VoiceModeButton disabled={busy} onclick={startVoiceChat} />
				{:else if (speech.recording || speech.busy) && !canSend}
					<!-- Nothing to send yet: the recording pill is the action while dictating. -->
					{#if voiceSupported && !coding && !modelMissing}
						<VoiceModeButton blockedReason="Finish dictating first" onclick={startVoiceChat} />
					{/if}
				{:else}
					<Button
						size="sm"
						aria-label="Send"
						disabled={!canSend}
						title={coding
							? (codingTask.blocker ?? 'Start coding task')
							: modelMissing
								? 'Select a model first'
								: untrustedModel
									? 'Pick a trusted model for a private chat'
									: 'Send'}
						onclick={() => startChat(displayInput)}
					>
						<ArrowUpIcon class="size-4" />
					</Button>
				{/if}
			</PromptInputActions>
		</PromptInput>
		<input
			bind:this={fileInput}
			type="file"
			multiple
			accept="image/*,audio/*,application/pdf,.txt,.md,.csv,.json,.xml,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip"
			class="hidden"
			onchange={filesChosen}
		/>
		{#if modelMissing && !coding}
			<p class="mt-2 text-sm text-muted-foreground">
				{#if hasModels}
					Select a model to start chatting.
				{:else if data.user.role === 'admin'}
					No models available yet.
					<a
						href="{resolve('/welcome')}?replay"
						class="font-medium text-foreground underline-offset-4 hover:underline">Finish setup</a
					>
				{:else}
					No models available. Ask an admin to configure one.
				{/if}
			</p>
		{:else if untrustedModel}
			<p class="mt-2 flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400">
				<TriangleAlertIcon class="size-4 shrink-0" />
				This model isn't trusted with private data. Pick a trusted model for a private chat.
			</p>
		{:else if isPrivate}
			<p class="mt-2 flex items-start gap-1.5 text-sm text-muted-foreground">
				<LockIcon
					class="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
					aria-hidden="true"
				/>
				<span>{PRIVATE_CHAT_HINT}</span>
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
			<div
				class="launch-chips mt-2 flex w-full max-w-2xl center-in-viewport flex-wrap justify-center gap-2"
			>
				{#each codingSuggestions as suggestion (suggestion)}
					<PromptSuggestion onclick={() => useSuggestion(suggestion)}>{suggestion}</PromptSuggestion
					>
				{/each}
			</div>
		{/if}
	{:else}
		<div
			class="launch-chips flex w-full max-w-2xl center-in-viewport flex-wrap justify-center gap-2"
		>
			{#each suggestions as suggestion (suggestion)}
				<PromptSuggestion onclick={() => startChat(suggestion)}>{suggestion}</PromptSuggestion>
			{/each}
		</div>
	{/if}
</div>
