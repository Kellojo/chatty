<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Label } from '$lib/components/ui/label/index.js';
	import { cn } from '$lib/utils.js';

	let {
		label,
		for: forId,
		labelId,
		description,
		descriptionId,
		stack = false,
		class: className,
		children
	}: {
		label: string;
		/** Id of the control, so clicking the label focuses or toggles it. */
		for?: string;
		/** Id for the label, for controls named with aria-labelledby (radio groups). */
		labelId?: string;
		description?: Snippet | string;
		/** Id for the description, for aria-describedby. */
		descriptionId?: string;
		/** Phones put the control under the label (selects, inputs); switches stay inline. */
		stack?: boolean;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<div
	class={cn(
		'flex justify-between gap-x-6 gap-y-2 border-t border-border/60 pt-4 first:border-t-0 first:pt-0',
		stack ? 'flex-col sm:flex-row sm:items-center' : 'items-center',
		className
	)}
>
	<div class="flex min-w-0 flex-col gap-1">
		<Label for={forId} id={labelId}>{label}</Label>
		{#if typeof description === 'string'}
			<p id={descriptionId} class="text-sm text-muted-foreground">{description}</p>
		{:else if description}
			<div id={descriptionId} class="text-sm text-muted-foreground">{@render description()}</div>
		{/if}
	</div>
	<div class={cn('flex shrink-0 items-center gap-2', stack && 'w-full sm:w-auto')}>
		{@render children()}
	</div>
</div>
