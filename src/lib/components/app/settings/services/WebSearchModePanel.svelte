<script lang="ts">
	import type { Snippet } from 'svelte';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ProviderIcon from '$lib/components/app/ProviderIcon.svelte';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import {
		saveSearchPreferences,
		WEB_SEARCH_NAMES,
		type SearchMode,
		type WebSearchProvider,
		type WebSearchState
	} from './web-search.js';

	/** How web searches use the connected providers: the mode switch and the order it gives. */
	let { info }: { info: WebSearchState } = $props();

	let saving = $state(false);

	async function setMode(value: string) {
		if (value === info.mode || saving) return;
		saving = true;
		await saveSearchPreferences({ mode: value as SearchMode });
		saving = false;
	}
</script>

{#snippet chip(id: WebSearchProvider)}
	<li
		class="flex items-center gap-1.5 rounded-full border border-border/60 bg-background py-0.5 pr-2.5 pl-1.5"
	>
		<ProviderIcon brand={id} class="size-3.5" decorative />{WEB_SEARCH_NAMES[id]}
	</li>
{/snippet}

{#snippet joiner(kind: 'and' | 'then')}
	<li class="flex items-center text-muted-foreground" aria-hidden="true">
		{#if kind === 'and'}<PlusIcon class="size-3.5" />{:else}<ArrowRightIcon class="size-3.5" />{/if}
	</li>
{/snippet}

<!--
	Both modes' texts are laid out in the same grid cell, the inactive one invisible, so the
	panel keeps its height when switching modes or toggling Backup only: nothing below jumps.
-->
{#snippet layer(mode: SearchMode, content: Snippet)}
	<div
		class={['col-start-1 row-start-1 min-w-0', info.mode !== mode && 'invisible']}
		aria-hidden={info.mode !== mode ? 'true' : undefined}
		inert={info.mode !== mode}
	>
		{@render content()}
	</div>
{/snippet}

{#snippet orderRow(
	label: string,
	listLabel: string,
	ids: WebSearchProvider[],
	kind: 'and' | 'then',
	empty?: string
)}
	<div class="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1.5">
		<span class="w-24 shrink-0 text-muted-foreground">{label}</span>
		{#if ids.length}
			<ol class="flex flex-wrap items-center gap-1.5" aria-label={listLabel}>
				{#each ids as id, i (id)}
					{#if i > 0}{@render joiner(kind)}{/if}
					{@render chip(id)}
				{/each}
			</ol>
		{:else}
			<span class="text-muted-foreground italic">{empty}</span>
		{/if}
	</div>
{/snippet}

{#snippet combinedSummary()}
	Every provider is searched at once and the results are merged into one list. Pages that several
	providers found rank higher.
{/snippet}
{#snippet fallbackSummary()}
	One provider answers each search. The next one is only tried when the one before it fails.
{/snippet}

{#snippet combinedOrder()}
	<div class="flex flex-col gap-2">
		{@render orderRow('Every search', 'Searched together', info.order.combined, 'and')}
		{@render orderRow(
			'If none answers',
			'Backup providers',
			info.order.backup,
			'and',
			'No backup providers'
		)}
	</div>
{/snippet}
{#snippet fallbackOrder()}
	{@render orderRow('Tried in order', 'Tried in this order', info.order.fallback, 'then')}
{/snippet}

{#snippet combinedNote()}
	Paid APIs are billed for every search they're part of. Set one to <span
		class="font-medium text-foreground">Backup only</span
	> in its settings to use it only when the others fail.
{/snippet}
{#snippet fallbackNote()}
	Change the order with <span class="font-medium text-foreground">Make default</span> and
	<span class="font-medium text-foreground">Backup only</span> in a provider's settings.
{/snippet}

<div class="flex flex-col gap-3 border-t border-border/60 px-(--card-spacing) py-4">
	<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
		<div class="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
			<span id="ws-mode-label" class="text-sm font-medium">How searches run</span>
			<span class="grid text-sm text-muted-foreground">
				{@render layer('combined', combinedSummary)}
				{@render layer('fallback', fallbackSummary)}
			</span>
		</div>
		<Tabs.Root value={info.mode} onValueChange={setMode}>
			<Tabs.List aria-labelledby="ws-mode-label">
				<Tabs.Trigger value="combined" disabled={saving}>Combined</Tabs.Trigger>
				<Tabs.Trigger value="fallback" disabled={saving}>Fallback</Tabs.Trigger>
			</Tabs.List>
		</Tabs.Root>
	</div>

	<!-- The order a web search actually uses, from the server's own plan. -->
	<div class="flex flex-col gap-2 rounded-xl bg-muted/60 p-3 text-xs">
		<div class="grid">
			{@render layer('combined', combinedOrder)}
			{@render layer('fallback', fallbackOrder)}
		</div>
		<p class="grid text-muted-foreground">
			{@render layer('combined', combinedNote)}
			{@render layer('fallback', fallbackNote)}
		</p>
		{#if info.perplexity.source}
			<p class="text-muted-foreground">News searches skip Perplexity, which has no news search.</p>
		{/if}
	</div>
</div>
