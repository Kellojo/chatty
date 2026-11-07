<script lang="ts">
	import { formatElapsed } from '$lib/formats.js';
	import { now } from '$lib/state/now.svelte.js';

	/** Seconds since `since`, ticking once a second ("12s", "1m 05s"). */
	let { since, class: className = '' }: { since: number; class?: string } = $props();

	const elapsed = $derived(formatElapsed(now() - since));
</script>

<span class="tabular-nums {className}">{elapsed}</span>
