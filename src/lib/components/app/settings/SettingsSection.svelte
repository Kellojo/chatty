<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import { cn } from '$lib/utils.js';

	let {
		title,
		description,
		icon,
		action,
		flush = false,
		class: className,
		contentClass,
		children
	}: {
		title?: string;
		description?: Snippet | string;
		/** Leading glyph in the title (e.g. a provider icon). */
		icon?: Snippet;
		/** Small control right of the title, such as a "Restore defaults" button. */
		action?: Snippet;
		/** Content runs edge to edge (lists with their own row padding). */
		flush?: boolean;
		class?: string;
		contentClass?: string;
		children: Snippet;
	} = $props();

	const hasHeader = $derived(Boolean(title || action));
</script>

<Card.Root class={cn('gap-4 rounded-2xl', flush && (hasHeader ? 'pb-2' : 'gap-0 py-2'), className)}>
	{#if hasHeader}
		<Card.Header class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
			<div class="flex min-w-0 flex-col gap-1">
				{#if title}
					<Card.Title class="flex min-w-0 items-center gap-2 text-base font-semibold">
						{@render icon?.()}
						<span class="truncate">{title}</span>
					</Card.Title>
				{/if}
				{#if typeof description === 'string'}
					<Card.Description>{description}</Card.Description>
				{:else if description}
					<Card.Description>{@render description()}</Card.Description>
				{/if}
			</div>
			{#if action}
				<div class="flex shrink-0 items-center gap-2">{@render action()}</div>
			{/if}
		</Card.Header>
	{/if}
	<Card.Content
		class={cn(flush ? 'px-0' : 'flex flex-col gap-4', !flush && hasHeader && 'pt-2', contentClass)}
	>
		{@render children()}
	</Card.Content>
</Card.Root>
