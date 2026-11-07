<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils.js';

	let {
		title,
		titleAttr,
		leading,
		badges,
		meta,
		trailing,
		muted = false,
		children
	}: {
		title: string;
		/** Hover text for the title, e.g. the full value when it truncates. */
		titleAttr?: string;
		leading?: Snippet;
		/** Inline chips after the title. */
		badges?: Snippet;
		/** Secondary line under the title. */
		meta?: Snippet;
		/** Switch and actions menu on the right. */
		trailing?: Snippet;
		/** Dim the row's text, e.g. for a disabled entry. */
		muted?: boolean;
		/** Extra content under the meta line. */
		children?: Snippet;
	} = $props();
</script>

<li class={cn('flex items-center gap-3 px-6', meta || children ? 'py-3' : 'py-2')}>
	{#if leading}
		<div
			class={cn(
				'flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground empty:bg-transparent',
				muted && 'opacity-60'
			)}
		>
			{@render leading()}
		</div>
	{/if}
	<div class={cn('flex min-w-0 flex-1 flex-col gap-0.5', muted && 'opacity-60')}>
		<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
			<span
				class="line-clamp-2 min-w-0 text-sm font-medium wrap-break-word"
				title={titleAttr ?? title}>{title}</span
			>
			{@render badges?.()}
		</div>
		{#if meta}
			<div class="min-w-0 truncate text-xs text-muted-foreground">{@render meta()}</div>
		{/if}
		{@render children?.()}
	</div>
	{#if trailing}
		<div class="flex shrink-0 items-center gap-1 sm:gap-2">{@render trailing()}</div>
	{/if}
</li>
