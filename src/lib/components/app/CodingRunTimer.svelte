<script lang="ts">
	import { formatElapsed } from '$lib/formats.js';
	import { now } from '$lib/state/now.svelte.js';
	import AnimatedElapsed from './AnimatedElapsed.svelte';

	/** Live "running for" timer for an agent run (coding task or chat reply). */
	let {
		startedAt,
		dot = true,
		coarse = false,
		class: className = ''
	}: {
		startedAt: number;
		dot?: boolean;
		/** Whole minutes after the first minute, without ticking seconds. */
		coarse?: boolean;
		class?: string;
	} = $props();

	const ms = $derived(now() - startedAt);
</script>

<span
	class="inline-flex shrink-0 items-center gap-1.5 text-xs tabular-nums {className}"
	title="Running for {formatElapsed(ms)}"
>
	{#if dot}
		<span
			class="size-1.5 shrink-0 animate-pulse rounded-full bg-info motion-reduce:animate-none"
			aria-hidden="true"
		></span>
	{/if}
	<span class="sr-only">Running for</span>
	<AnimatedElapsed {ms} {coarse} />
</span>
