<script lang="ts">
	import { now } from '$lib/state/now.svelte.js';
	import AnimatedElapsed from './AnimatedElapsed.svelte';

	/** Seconds since `since`, ticking once a second ("12s", "1m 05s"). */
	let { since, class: className = '' }: { since: number; class?: string } = $props();
</script>

<span class="tabular-nums {className}"><AnimatedElapsed ms={now() - since} /></span>
