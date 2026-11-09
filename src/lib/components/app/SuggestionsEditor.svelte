<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import { MAX_SUGGESTIONS } from '$lib/user-settings.js';
	import { guardUnsavedChanges } from '$lib/components/app/settings/unsaved-changes.js';

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

	// An empty list already means "show the defaults", so either counts as default.
	const isDefault = $derived(
		cleanedRows.length === 0 ||
			(cleanedRows.length === defaults.length && cleanedRows.every((t, i) => t === defaults[i]))
	);

	guardUnsavedChanges(() => dirty);

	/** Stages an empty list, which follows the built-in defaults; Save commits it. */
	function resetToDefaults() {
		rows = [];
	}

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
					<!-- Grows to show the whole suggestion instead of clipping it; Enter doesn't add lines. -->
					<Textarea
						bind:value={row.text}
						maxlength={200}
						rows={1}
						class="min-h-9 resize-none rounded-3xl px-3 py-2 pointer-coarse:min-h-10"
						placeholder="Suggestion text"
						aria-label="{title} {i + 1}"
						onkeydown={(e) => {
							if (e.key === 'Enter') e.preventDefault();
						}}
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
		<div class="flex flex-wrap items-center gap-1">
			<Button variant="ghost" size="sm" onclick={addRow} disabled={rows.length >= MAX_SUGGESTIONS}>
				<PlusIcon class="size-4" />
				Add suggestion
			</Button>
			{#if !isDefault}
				<Button variant="ghost" size="sm" onclick={resetToDefaults}>
					<RotateCcwIcon class="size-4" />
					Reset to defaults
				</Button>
			{/if}
		</div>
		<div class="flex items-center gap-3">
			<span class="text-xs text-muted-foreground tabular-nums"
				>{rows.length} of {MAX_SUGGESTIONS}</span
			>
			{#if dirty}
				<span class="text-xs text-muted-foreground">Unsaved changes</span>
			{/if}
			<Button size="sm" onclick={onSave} disabled={busy || !dirty}>
				{busy ? 'Saving…' : 'Save'}
			</Button>
		</div>
	</div>
</SettingsSection>
