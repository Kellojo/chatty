<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatAge } from '$lib/formats.js';
	import { clockTime, refreshAaScores, type AaState } from './artificial-analysis.svelte.js';

	/** One-line credit and status under the models list; the key lives in Settings → Services. */
	let { aa }: { aa: AaState } = $props();

	let refreshing = $state(false);
	const busy = $derived(refreshing);

	async function refresh() {
		refreshing = true;
		await refreshAaScores();
		refreshing = false;
	}

	const link = 'underline underline-offset-4 hover:text-foreground';
</script>

<p class="px-1 text-xs text-muted-foreground" aria-live="polite">
	{#if aa.key.source}
		Intelligence scores from <a
			class={link}
			href="https://artificialanalysis.ai"
			target="_blank"
			rel="noreferrer">Artificial Analysis</a
		>
		·
		{#if busy}
			refreshing…
		{:else if aa.status.lastError}
			<span class="text-destructive"
				>{aa.status.lastError}{#if aa.status.retryAfter && aa.status.retryAfter > Date.now()}, retry
					after {clockTime(aa.status.retryAfter)}{/if}</span
			>
		{:else if aa.status.fetchedAt}
			updated {formatAge(Date.now() - aa.status.fetchedAt)} ago
		{/if}
		{#if !busy}
			· <button type="button" class="{link} cursor-pointer" onclick={refresh}>Refresh</button>
		{/if}
		·
		<a class={link} href="{resolve('/settings/services')}?configure=artificial-analysis">Manage</a>
	{:else}
		Rank models by intelligence: add an Artificial Analysis key in
		<a class={link} href={resolve('/settings/services')}>Services</a>.
	{/if}
</p>
