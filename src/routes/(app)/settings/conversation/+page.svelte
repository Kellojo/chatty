<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { invalidateAll } from '$app/navigation';
	import { Switch } from '$lib/components/ui/switch/index.js';
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
	import { onMount, untrack } from 'svelte';
	import SettingsRow from '$lib/components/app/settings/SettingsRow.svelte';
	import SpeechPreviewButton from '$lib/components/app/settings/SpeechPreviewButton.svelte';
	import { createSpeechPlayback } from '$lib/state/speech-playback.svelte.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let instructions = $state(data.settings.globalInstructions);
	let savedInstructions = $state(data.settings.globalInstructions);
	let instructionsBusy = $state(false);

	async function putSettings(body: {
		suggestions?: string[];
		codingSuggestions?: string[];
		globalInstructions?: string;
		speechVolume?: number;
		privateByDefault?: boolean;
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

	// Read-aloud volume, as a percentage; saved when the slider is released.
	let volume = $state(untrack(() => Math.round(data.settings.speechVolume * 100)));
	let savedVolume = untrack(() => data.settings.speechVolume);
	const playback = createSpeechPlayback({
		serverTts: () => data.serverTts,
		onerror: (message) => toast.error(message),
		volume: () => volume / 100,
		// A sample text, not chat content.
		privacy: () => ({ private: false })
	});
	onMount(() => playback.stop);

	async function saveVolume() {
		const next = volume / 100;
		if (next === savedVolume) return;
		try {
			await putSettings({ speechVolume: next });
			savedVolume = next;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to save volume');
		}
	}

	// Shown while a change is saving, until the refreshed settings agree.
	let privatePending = $state<boolean | null>(null);
	const privateByDefault = $derived(privatePending ?? data.settings.privateByDefault);

	async function setPrivateByDefault(value: boolean) {
		privatePending = value;
		try {
			await putSettings({ privateByDefault: value });
			await invalidateAll().catch(() => undefined);
		} catch {
			toast.error("Couldn't change the setting. Try again.");
		}
		if (privatePending === value) privatePending = null;
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

{#if data.privateData.enabled}
	<SettingsSection title="Privacy">
		<SettingsRow
			label="New chats are private"
			for="pref-private-by-default"
			description={data.privateData.available
				? 'New chats start with the lock on: only models trusted with private data see them. You can still turn it off per chat. Coding tasks are never private.'
				: 'Takes effect once a provider is trusted with private data (Settings → Providers).'}
		>
			<Switch
				id="pref-private-by-default"
				checked={privateByDefault}
				onCheckedChange={setPrivateByDefault}
			/>
		</SettingsRow>
	</SettingsSection>
{/if}

<SettingsSection
	title="Read aloud"
	description="How replies sound when you use the read-aloud button."
>
	<SettingsRow label="Volume" for="speech-volume" stack>
		<div class="flex w-full items-center gap-3 sm:w-auto">
			<input
				id="speech-volume"
				type="range"
				min="0"
				max="100"
				step="5"
				bind:value={volume}
				onchange={saveVolume}
				aria-valuetext={`${volume}%`}
				class="h-2 w-full cursor-pointer accent-primary sm:w-48"
			/>
			<span class="w-10 shrink-0 text-right text-sm text-muted-foreground tabular-nums"
				>{volume}%</span
			>
			<SpeechPreviewButton
				{playback}
				label="Test"
				text="This is how loud replies will be read aloud."
			/>
		</div>
	</SettingsRow>
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
