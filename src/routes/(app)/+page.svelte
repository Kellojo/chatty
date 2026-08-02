<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
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
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import XIcon from '@lucide/svelte/icons/x';
	import ModelPicker from '$lib/components/app/ModelPicker.svelte';
	import MicButton from '$lib/components/app/MicButton.svelte';
	import { createSpeechRecognition } from '$lib/state/speech-recognition.svelte.js';
	import { decodeModelRef } from '$lib/model-ref.js';
	import { pendingMessage } from '$lib/state/pending-message.svelte.js';
	import { createFileDrop } from '$lib/state/file-drop.svelte.js';
	import { DEFAULT_SUGGESTIONS } from '$lib/user-settings.js';
	import type { Conversation } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let input = $state('');
	const speech = createSpeechRecognition();
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

	$effect(() => {
		if (page.url.searchParams.get('error') === 'conversation-not-found') {
			toast.error('Conversation not found');
			goto(resolve('/'), { replaceState: true });
		}
	});

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

	const defaultModelValue = $derived(
		data.defaultModel ? `${data.defaultModel.providerId}/${data.defaultModel.modelId}` : ''
	);
	const selectedValue = $derived(picked || defaultModelValue);
	const hasModels = $derived(data.groups.some((g) => g.models.length > 0));
	const modelMissing = $derived(!hasModels || selectedValue === '');
	const canSend = $derived(
		(input.trim().length > 0 || selectedFiles.length > 0) && !busy && !modelMissing
	);
	const suggestions = $derived(
		data.suggestions.length > 0 ? data.suggestions : DEFAULT_SUGGESTIONS
	);
	const personaLabel = $derived(
		personaId === '' ? 'I' : (data.personas.find((p) => p.id === personaId)?.name ?? 'I')
	);

	async function startChat(text: string) {
		speech.stop();
		speech.reset();
		const trimmed = text.trim();
		if ((!trimmed && selectedFiles.length === 0) || busy || modelMissing) return;
		busy = true;
		try {
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
			pendingMessage.set(trimmed, selectedFiles);
			await invalidateAll();
			goto(resolve(`/chat/${conversation.id}`));
		} catch (e) {
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
>
	{#if fileDrop.dragActive}
		<div
			class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-info bg-background/70"
		>
			<span class="text-sm font-medium text-muted-foreground">Drop files to attach</span>
		</div>
	{/if}
	{#if data.personas.length > 0}
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
	<div class="w-full max-w-2xl">
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
			onSubmit={() => startChat(displayInput)}
		>
			<PromptInputTextarea placeholder="Ask anything…" />
			<PromptInputActions class="justify-between">
				<div class="flex items-center gap-1">
					<ModelPicker
						groups={data.groups}
						mappings={data.mappings}
						value={selectedValue}
						onselect={(v) => (picked = v)}
						disabled={busy}
					/>
					<Button variant="ghost" size="icon" aria-label="Attach files" onclick={pickFiles}>
						<PaperclipIcon class="size-4" />
					</Button>
					<MicButton {speech} />
				</div>
				<Button
					size="sm"
					aria-label="Send"
					disabled={!canSend}
					title={modelMissing ? 'Select a model first' : 'Send'}
					onclick={() => startChat(input)}
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
		{#if modelMissing}
			<p class="mt-2 text-sm text-muted-foreground">
				{hasModels
					? 'Select a model to start chatting.'
					: 'No models available. Ask an admin to configure one.'}
			</p>
		{/if}
	</div>
	<div class="flex max-w-2xl flex-wrap justify-center gap-2">
		{#each suggestions as suggestion (suggestion)}
			<PromptSuggestion onclick={() => startChat(suggestion)}>{suggestion}</PromptSuggestion>
		{/each}
	</div>
</div>
