<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { MAX_SUGGESTIONS } from '$lib/user-settings.js';

	let {
		title,
		description,
		initial,
		defaults,
		save
	}: {
		title: string;
		description: string;
		initial: string[];
		/** Shown on the home page when the list is saved empty. */
		defaults: string[];
		/** Persists the cleaned list; throws with a user-facing message on failure. */
		save: (suggestions: string[]) => Promise<void>;
	} = $props();

	const toRows = (list: string[]) => list.map((text) => ({ id: crypto.randomUUID(), text }));

	// The editor owns its rows after the first render.
	let rows = $state(untrack(() => toRows(initial)));
	let busy = $state(false);

	function addRow() {
		if (rows.length >= MAX_SUGGESTIONS) return;
		rows = [...rows, { id: crypto.randomUUID(), text: '' }];
	}

	function removeRow(id: string) {
		rows = rows.filter((row) => row.id !== id);
	}

	async function onSave() {
		if (busy) return;
		const cleaned = rows.map((row) => row.text.trim()).filter((text) => text.length > 0);
		busy = true;
		try {
			await save(cleaned);
			rows = toRows(cleaned);
			toast.success(`${title} saved`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : `Failed to save ${title.toLowerCase()}`);
		} finally {
			busy = false;
		}
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>{title}</Card.Title>
		<Card.Description>{description} Up to {MAX_SUGGESTIONS} suggestions.</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		{#each rows as row (row.id)}
			<div class="flex items-center gap-2">
				<Input bind:value={row.text} maxlength={200} placeholder="Suggestion text" />
				<Button
					variant="ghost"
					size="sm"
					onclick={() => removeRow(row.id)}
					aria-label="Remove suggestion"
				>
					<XIcon class="size-4" />
				</Button>
			</div>
		{:else}
			<p class="text-sm text-muted-foreground">
				No suggestions, so the defaults are shown: {defaults.join(' · ')}
			</p>
		{/each}
		<div class="flex items-center gap-2">
			<Button
				variant="outline"
				size="sm"
				onclick={addRow}
				disabled={rows.length >= MAX_SUGGESTIONS}
			>
				Add suggestion
			</Button>
			<Button size="sm" onclick={onSave} disabled={busy}>
				{busy ? 'Saving…' : 'Save suggestions'}
			</Button>
		</div>
	</Card.Content>
</Card.Root>
