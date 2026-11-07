<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
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

	async function resetInstructions() {
		if (instructionsBusy || !savedInstructions) return;
		instructionsBusy = true;
		try {
			await putSettings({ globalInstructions: '' });
			instructions = '';
			savedInstructions = '';
			toast.success('Instructions cleared');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to reset instructions');
		} finally {
			instructionsBusy = false;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<h2 class="text-xl font-semibold">Conversation</h2>
	<p class="text-sm text-muted-foreground">Chat appearance and response behavior.</p>

	<SuggestionsEditor
		title="Chat suggestions"
		description="Quick-start chips on the home page in Chat mode; clicking one sends it."
		initial={data.settings.suggestions}
		defaults={DEFAULT_SUGGESTIONS}
		save={(suggestions) => putSettings({ suggestions })}
	/>

	<SuggestionsEditor
		title="Coding suggestions"
		description="Quick-start chips on the home page in Code mode; clicking one fills in the task so you can add details."
		initial={data.settings.codingSuggestions}
		defaults={DEFAULT_CODING_SUGGESTIONS}
		save={(codingSuggestions) => putSettings({ codingSuggestions })}
	/>

	<Card.Root>
		<Card.Header>
			<Card.Title>Response instructions</Card.Title>
			<Card.Description>
				Tell the assistant how to respond (e.g. "never use emojis"). Applies to every chat, in
				addition to any per-conversation system prompt.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2">
			<Textarea
				bind:value={instructions}
				rows={4}
				maxlength={MAX_GLOBAL_INSTRUCTIONS_LENGTH}
				placeholder="e.g. Answer concisely and never use emojis."
			/>
			<div class="flex items-center justify-between">
				<p class="text-xs text-muted-foreground">
					This is added to the system prompt of every chat. Leave empty for no global instructions.
				</p>
				<span class="shrink-0 text-xs text-muted-foreground"
					>{instructions.length}/{MAX_GLOBAL_INSTRUCTIONS_LENGTH}</span
				>
			</div>
			<div class="flex justify-end gap-2">
				<Button
					variant="outline"
					size="sm"
					onclick={resetInstructions}
					disabled={instructionsBusy || !savedInstructions}
				>
					Clear
				</Button>
				<Button
					size="sm"
					onclick={saveInstructions}
					disabled={instructionsBusy || instructions.trim() === savedInstructions}
				>
					{instructionsBusy ? 'Saving…' : 'Save instructions'}
				</Button>
			</div>
		</Card.Content>
	</Card.Root>
</div>
