<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Label } from '$lib/components/ui/label/index.js';
	import { cn } from '$lib/utils.js';

	let {
		label,
		for: forId,
		description,
		stack = false,
		class: className,
		children
	}: {
		label: string;
		/** Id of the control, so clicking the label focuses or toggles it. */
		for?: string;
		description?: Snippet | string;
		/** Phones put the control under the label (selects, inputs); switches stay inline. */
		stack?: boolean;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<div
	class={cn(
		'flex justify-between gap-x-6 gap-y-2',
		stack ? 'flex-col sm:flex-row sm:items-center' : 'items-center',
		className
	)}
>
	<div class="flex min-w-0 flex-col gap-1">
		<Label for={forId}>{label}</Label>
		{#if typeof description === 'string'}
			<p class="text-sm text-muted-foreground">{description}</p>
		{:else if description}
			<div class="text-sm text-muted-foreground">{@render description()}</div>
		{/if}
	</div>
	<div class={cn('flex shrink-0 items-center gap-2', stack && 'w-full sm:w-auto')}>
		{@render children()}
	</div>
</div>
