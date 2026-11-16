<script lang="ts">
	import LockIcon from '@lucide/svelte/icons/lock';
	import { cn } from '$lib/utils.js';

	let { class: className }: { class?: string } = $props();
</script>

<!-- Marks a private memory: only models trusted with private data can see it. -->
<span
	class={cn('inline-flex shrink-0 text-muted-foreground', className)}
	role="img"
	title="Private"
	aria-label="Private"
>
	<LockIcon class="size-3" aria-hidden="true" />
</span>
