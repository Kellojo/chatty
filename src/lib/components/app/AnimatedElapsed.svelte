<script lang="ts">
	import NumberFlow, { NumberFlowGroup } from '@number-flow/svelte';
	import { onMount } from 'svelte';
	import { elapsedParts, formatElapsed } from '$lib/formats.js';

	/** A live `formatElapsed` duration ("42s", "4m 05s", "1h 12m") whose digits roll as it ticks. */
	let {
		ms,
		coarse = false
	}: {
		ms: number;
		/** Whole minutes after the first minute ("4m"), for places where ticking seconds are noise. */
		coarse?: boolean;
	} = $props();

	const parts = $derived(elapsedParts(ms, { coarse }));
	/**
	 * NumberFlow's element rewrites its own server-rendered children when it
	 * upgrades, so they can't be hydrated: Svelte would then remount the whole
	 * page. The server (and hydration) render plain text; the digits roll from then on.
	 */
	let mounted = $state(false);
	onMount(() => (mounted = true));
	const PADDED = { minimumIntegerDigits: 2 };
</script>

<!-- Screen readers (and text queries) get the plain text; the rolling digits are decoration,
     spaced with margin rather than text so the element's text stays exactly "4m 05s". -->
<span class="sr-only">{formatElapsed(ms, { coarse })}</span><span aria-hidden="true"
	>{#if !mounted}{formatElapsed(ms, { coarse })}{:else}<NumberFlowGroup
			><!-- Keyed by unit, so 59s → 1m 00s swaps parts instead of rolling seconds into minutes.
		     trend 1: time only goes up, so :59 → :00 rolls forward, not back. -->{#each parts as part, i (part.unit)}<NumberFlow
					class={i ? 'ml-[0.25em]' : undefined}
					value={part.value}
					format={i ? PADDED : undefined}
					suffix={part.unit}
					trend={1}
				/>{/each}</NumberFlowGroup
		>{/if}</span
>
