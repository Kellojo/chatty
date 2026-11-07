<script lang="ts">
	import { formatElapsed } from '$lib/formats.js';
	import { now } from '$lib/state/now.svelte.js';

	/** Live "running for" timer for a coding task's agent run. */
	let {
		startedAt,
		dot = true,
		class: className = ''
	}: { startedAt: number; dot?: boolean; class?: string } = $props();

	const elapsed = $derived(formatElapsed(now() - startedAt));
</script>

<span
	class="inline-flex shrink-0 items-center gap-1.5 text-xs tabular-nums {className}"
	title="Agent running for {elapsed}"
>
	{#if dot}
		<span
			class="size-1.5 shrink-0 animate-pulse rounded-full bg-info motion-reduce:animate-none"
			aria-hidden="true"
		></span>
	{/if}
	<span class="sr-only">Running for</span>
	{elapsed}
</span>
