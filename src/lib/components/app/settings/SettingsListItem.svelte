<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils.js';

	let {
		title,
		titleAttr,
		href,
		onclick,
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
		/** Makes the title a link to the entry's own page (an already resolved path). */
		href?: string;
		/** Makes the whole row a button for the entry's main action, e.g. opening its edit dialog.
		 *  Ignored when `href` is set. */
		onclick?: () => void;
		leading?: Snippet;
		/** Inline chips after the title. */
		badges?: Snippet;
		/** Secondary line under the title. */
		meta?: Snippet;
		/** Switch and actions menu on the right. */
		trailing?: Snippet;
		/** Dim the row's icon and title, e.g. for a disabled entry (its switch shows the state). */
		muted?: boolean;
		/** Extra content under the meta line. */
		children?: Snippet;
	} = $props();
</script>

<!-- With an href or onclick the whole row is the title's click target (a stretched ::after);
	trailing controls sit above it. Other interactive content inside the row needs `relative z-10`. -->
<li
	class={cn(
		'flex items-center gap-3 px-(--card-spacing)',
		meta || children ? 'py-3' : 'py-2',
		(href || onclick) &&
			'relative hover:bg-accent/40 has-[[data-row-target]:focus-visible]:bg-accent/40 has-[[data-row-target]:focus-visible]:ring-2 has-[[data-row-target]:focus-visible]:ring-ring has-[[data-row-target]:focus-visible]:ring-inset'
	)}
>
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
	<div class="flex min-w-0 flex-1 flex-col gap-0.5">
		<div
			class={cn(
				'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1',
				muted && 'text-muted-foreground'
			)}
		>
			{#if href}
				<!-- eslint-disable svelte/no-navigation-without-resolve -- callers pass resolve()d hrefs -->
				<a
					{href}
					data-row-target
					class="line-clamp-2 min-w-0 rounded-sm text-sm font-medium wrap-break-word outline-none after:absolute after:inset-0 after:content-['']"
					title={titleAttr ?? title}>{title}</a
				>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{:else if onclick}
				<button
					type="button"
					{onclick}
					data-row-target
					class="line-clamp-2 min-w-0 cursor-pointer rounded-sm text-left text-sm font-medium wrap-break-word outline-none after:absolute after:inset-0 after:content-['']"
					title={titleAttr ?? title}>{title}</button
				>
			{:else}
				<span
					class="line-clamp-2 min-w-0 text-sm font-medium wrap-break-word"
					title={titleAttr ?? title}>{title}</span
				>
			{/if}
			{@render badges?.()}
		</div>
		{#if meta}
			<div
				class="min-w-0 text-xs wrap-break-word text-muted-foreground max-sm:line-clamp-2 sm:truncate"
			>
				{@render meta()}
			</div>
		{/if}
		{@render children?.()}
	</div>
	{#if trailing}
		<div class="relative z-10 flex shrink-0 items-center gap-3 sm:gap-2">
			{@render trailing()}
		</div>
	{/if}
</li>
