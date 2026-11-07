<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
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
	let saved = $state(untrack(() => [...initial]));

	const cleanedRows = $derived(
		rows.map((row) => row.text.trim()).filter((text) => text.length > 0)
	);
	const dirty = $derived(
		cleanedRows.length !== saved.length || cleanedRows.some((text, i) => text !== saved[i])
	);

	function addRow() {
		if (rows.length >= MAX_SUGGESTIONS) return;
		rows = [...rows, { id: crypto.randomUUID(), text: '' }];
	}

	function removeRow(id: string) {
		rows = rows.filter((row) => row.id !== id);
	}

	async function onSave() {
		if (busy) return;
		const cleaned = cleanedRows;
		busy = true;
		try {
			await save(cleaned);
			rows = toRows(cleaned);
			saved = [...cleaned];
			toast.success(`${title} saved`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : `Failed to save ${title.toLowerCase()}`);
		} finally {
			busy = false;
		}
	}
</script>

<SettingsSection {title} {description}>
	{#if rows.length > 0}
		<ul class="flex flex-col gap-2">
			{#each rows as row, i (row.id)}
				<li class="flex items-center gap-2">
					<Input
						bind:value={row.text}
						maxlength={200}
						placeholder="Suggestion text"
						aria-label="{title} {i + 1}"
					/>
					<Button
						variant="ghost"
						size="icon-sm"
						class="shrink-0"
						onclick={() => removeRow(row.id)}
						aria-label="Remove suggestion {i + 1}"
						title="Remove"
					>
						<XIcon class="size-4" />
					</Button>
				</li>
			{/each}
		</ul>
	{:else}
		<div
			class="rounded-xl border border-dashed border-border/80 px-4 py-3 text-sm text-muted-foreground"
		>
			<p>No custom suggestions, so the home page shows the defaults:</p>
			<p class="mt-1 text-foreground/80">{defaults.join(' · ')}</p>
		</div>
	{/if}
	<div class="flex flex-wrap items-center justify-between gap-2">
		<Button variant="ghost" size="sm" onclick={addRow} disabled={rows.length >= MAX_SUGGESTIONS}>
			<PlusIcon class="size-4" />
			Add suggestion
			<span class="text-muted-foreground tabular-nums">{rows.length}/{MAX_SUGGESTIONS}</span>
		</Button>
		<Button size="sm" onclick={onSave} disabled={busy || !dirty}>
			{busy ? 'Saving…' : 'Save'}
		</Button>
	</div>
</SettingsSection>
