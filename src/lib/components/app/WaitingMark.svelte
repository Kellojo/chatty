<script lang="ts">
	import HourglassIcon from '@lucide/svelte/icons/hourglass';
	import { syncAnimation } from '$lib/sync-animation.js';

	/**
	 * The mark of a coding task waiting on background work: an hourglass that
	 * flips now and then, the calm sibling of the working spinner (it isn't busy,
	 * but it will pick up again by itself). Reduced motion keeps it still.
	 */
	let { class: className = 'size-3' }: { class?: string } = $props();
</script>

<!-- Synced so every waiting hourglass flips together. Decorative: a "Waiting"
     label always sits next to it. -->
<span class="flex hourglass-flip" aria-hidden="true" {@attach syncAnimation}>
	<HourglassIcon class={className} strokeWidth={2.5} />
</span>
