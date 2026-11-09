<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { guardUnsavedChanges } from '$lib/components/app/settings/unsaved-changes.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SuggestionsEditor from '$lib/components/app/SuggestionsEditor.svelte';
	import {
		DEFAULT_CODING_SUGGESTIONS,
		DEFAULT_SUGGESTIONS,
		MAX_GLOBAL_INSTRUCTIONS_LENGTH
	} from '$lib/user-settings.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let instructions = $state(data.settings.globalInstructions);
	let savedInstructions = $state(data.settings.globalInstructions);
	let instructionsBusy = $state(false);

	async function putSettings(body: {
		suggestions?: string[];
		codingSuggestions?: string[];
		globalInstructions?: string;
	}) {
		const res = await fetch('/api/user/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			const payload = (await res.json().catch(() => null)) as { message?: string } | null;
			throw new Error(payload?.message ?? `Request failed (${res.status})`);
		}
	}

	async function saveInstructions() {
		if (instructionsBusy) return;
		const trimmed = instructions.trim();
		if (trimmed === savedInstructions) return;
		instructionsBusy = true;
		try {
			await putSettings({ globalInstructions: trimmed });
			savedInstructions = trimmed;
			toast.success(trimmed ? 'Instructions saved' : 'Instructions cleared');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to save instructions');
		} finally {
			instructionsBusy = false;
		}
	}

	const instructionsDirty = $derived(instructions.trim() !== savedInstructions);
	guardUnsavedChanges(() => instructionsDirty);
</script>

<svelte:head><title>Conversation · Settings · Chatty</title></svelte:head>

<SettingsHeader
	title="Conversation"
	description="How the assistant responds and what the start screen suggests."
/>

<SettingsSection
	title="Response instructions"
	description="Tell the assistant how to respond, e.g. “never use emojis”. Added to every chat, on top of any per-conversation system prompt."
>
	<div class="flex flex-col gap-1.5">
		<Textarea
			bind:value={instructions}
			rows={4}
			maxlength={MAX_GLOBAL_INSTRUCTIONS_LENGTH}
			placeholder="e.g. Answer concisely and never use emojis."
			aria-label="Response instructions"
		/>
		<div class="flex justify-between gap-4 text-xs text-muted-foreground">
			<span>Leave empty for no global instructions.</span>
			<span class="shrink-0 tabular-nums"
				>{instructions.length.toLocaleString()} / {MAX_GLOBAL_INSTRUCTIONS_LENGTH.toLocaleString()}</span
			>
		</div>
	</div>
	<div class="flex items-center justify-end gap-2">
		{#if instructionsDirty && !instructionsBusy}
			<span class="mr-1 text-xs text-muted-foreground">Unsaved changes</span>
		{/if}
		<!-- Clearing only empties the field; Save commits it like any other edit. -->
		<Button
			variant="ghost"
			size="sm"
			onclick={() => (instructions = '')}
			disabled={instructionsBusy || !instructions}
		>
			Clear
		</Button>
		<Button size="sm" onclick={saveInstructions} disabled={instructionsBusy || !instructionsDirty}>
			{instructionsBusy ? 'Saving…' : 'Save'}
		</Button>
	</div>
</SettingsSection>

<SuggestionsEditor
	title="Chat suggestions"
	description="Quick-start chips on the home page in Chat mode; choosing one sends it."
	initial={data.settings.suggestions}
	defaults={DEFAULT_SUGGESTIONS}
	save={(suggestions) => putSettings({ suggestions })}
/>

<SuggestionsEditor
	title="Coding suggestions"
	description="Quick-start chips on the home page in Code mode; choosing one fills in the task so you can add details."
	initial={data.settings.codingSuggestions}
	defaults={DEFAULT_CODING_SUGGESTIONS}
	save={(codingSuggestions) => putSettings({ codingSuggestions })}
/>
