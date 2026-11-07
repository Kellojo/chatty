<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { cn } from '$lib/utils.js';

	/**
	 * Shared shell for the rich ```fence widgets in chat (weather, chart, map,
	 * chats, …): one card style, header, loading skeleton and error state, so
	 * the widgets read like the rest of the app's cards.
	 */
	let {
		icon: Icon,
		title,
		subtitle,
		meta,
		status = 'ready',
		loadingLabel = 'Loading…',
		errorLabel = 'Could not render this block',
		divided = true,
		skeletonClass,
		raw,
		class: className,
		children
	}: {
		icon: Component<{ class?: string }>;
		/** Header title; without it the header is omitted. */
		title?: string | null;
		subtitle?: string | null;
		/** Quiet text or controls at the right of the header. */
		meta?: Snippet | string | null;
		status?: 'loading' | 'error' | 'ready';
		loadingLabel?: string;
		errorLabel?: string;
		/** Draw a hairline between the header and the body. */
		divided?: boolean;
		/** Height placeholder while loading, roughly the finished widget's body, so content below doesn't jump. */
		skeletonClass?: string;
		/** The fence's raw text, offered in the error state so nothing is lost. */
		raw?: string;
		class?: string;
		children?: Snippet;
	} = $props();
</script>

{#snippet tile(error = false)}
	<div
		class={cn(
			'flex size-8 shrink-0 items-center justify-center rounded-lg',
			error ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
		)}
		aria-hidden="true"
	>
		{#if error}
			<TriangleAlertIcon class="size-4" />
		{:else}
			<Icon class="size-4" />
		{/if}
	</div>
{/snippet}

<section
	class={cn(
		'my-4 w-full min-w-0 overflow-hidden rounded-2xl border border-border/60 bg-card text-card-foreground shadow-xs',
		className
	)}
	aria-busy={status === 'loading' || undefined}
>
	{#if status === 'loading'}
		<div class="flex items-center gap-3 px-4 py-3">
			{@render tile()}
			<div class="flex min-w-0 flex-1 flex-col gap-1.5">
				<span class="text-sm text-muted-foreground">{loadingLabel}</span>
				<div
					class="h-1.5 w-2/5 animate-pulse rounded-full bg-muted motion-reduce:animate-none"
				></div>
			</div>
		</div>
		{#if skeletonClass}
			<div class="px-4 pb-4">
				<div
					class={cn(
						'animate-pulse rounded-xl bg-muted/40 motion-reduce:animate-none',
						skeletonClass
					)}
				></div>
			</div>
		{/if}
	{:else if status === 'error'}
		<div class="flex flex-col gap-2 px-4 py-3" role="status">
			<div class="flex items-center gap-3">
				{@render tile(true)}
				<div class="flex min-w-0 flex-col">
					<span class="text-sm font-medium">{errorLabel}</span>
					<span class="text-xs text-muted-foreground"
						>The response contained data this widget couldn’t read.</span
					>
				</div>
			</div>
			{#if raw?.trim()}
				<details class="group/raw ml-11 text-xs">
					<summary
						class="w-fit cursor-pointer rounded-sm text-muted-foreground select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
					>
						Show raw data
					</summary>
					<pre
						class="mt-2 max-h-48 overflow-auto rounded-lg bg-muted/50 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{raw}</pre>
				</details>
			{/if}
		</div>
	{:else}
		{#if title}
			<header
				class={cn(
					'flex min-w-0 items-center gap-3 px-4 py-3',
					divided && 'border-b border-border/60'
				)}
			>
				{@render tile()}
				<div class="flex min-w-0 flex-1 flex-col">
					<h3 class="truncate text-sm leading-5 font-medium" {title}>{title}</h3>
					{#if subtitle}
						<p class="truncate text-xs text-muted-foreground" title={subtitle}>{subtitle}</p>
					{/if}
				</div>
				{#if typeof meta === 'string'}
					<span class="shrink-0 text-xs text-muted-foreground tabular-nums">{meta}</span>
				{:else if meta}
					<div class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
						{@render meta()}
					</div>
				{/if}
			</header>
		{/if}
		{@render children?.()}
	{/if}
</section>
