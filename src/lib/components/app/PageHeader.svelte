<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { buttonRowClasses, getSidebarState } from './sidebar-state.svelte.js';

	let {
		title,
		icon: Icon,
		back,
		description,
		badges,
		actions
	}: {
		title: string;
		/** Section glyph before the title (top-level pages, like Usage and Settings). */
		icon?: Component<{ class?: string }>;
		/** Parent page link shown above the title on detail pages. */
		back?: { href: string; label: string };
		description?: Snippet | string;
		/** Chips after the title. */
		badges?: Snippet;
		/** Primary page actions, right of the title (under it on phones). */
		actions?: Snippet;
	} = $props();

	const sidebar = getSidebarState();
	const row = $derived(buttonRowClasses(sidebar));
	// The back link indents with a margin (its own padding is the hover area).
	const backClear = $derived(
		!sidebar || sidebar.open
			? 'ml-9 md:-ml-1 md:h-auto'
			: 'ml-9 md:max-xl:ml-8 md:max-xl:h-9 xl:-ml-1 xl:h-auto'
	);
</script>

<!-- The first line shares a row with the floating "open sidebar" button wherever it can
     overlap (see buttonRowClasses): pulled up to its top and height, and padded to clear it. -->
<header class="flex flex-col gap-1 {row.lift}">
	{#if back}
		<!-- eslint-disable svelte/no-navigation-without-resolve -- callers pass resolve()d hrefs -->
		<a
			href={back.href}
			class="flex h-10 w-fit items-center gap-1 rounded-md px-1 text-sm text-muted-foreground transition-colors hover:text-foreground {backClear}"
		>
			<ArrowLeftIcon class="size-3.5" aria-hidden="true" />
			{back.label}
		</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	{/if}
	<!-- Phones: title, description, actions. Wider: actions sit on the title's row. -->
	<div class="grid gap-x-6 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
		<div
			class="flex min-h-10 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 md:min-h-9 {back
				? ''
				: row.pad}"
		>
			<h1 class="flex min-w-0 items-center gap-2 text-xl font-semibold">
				{#if Icon}<Icon class="size-5 shrink-0" />{/if}
				<span class="truncate">{title}</span>
			</h1>
			{@render badges?.()}
		</div>
		{#if description}
			<p class="max-w-2xl text-sm text-pretty text-muted-foreground sm:col-start-1 sm:row-start-2">
				{#if typeof description === 'string'}{description}{:else}{@render description()}{/if}
			</p>
		{/if}
		{#if actions}
			<div
				class="mt-2 flex flex-wrap items-center gap-2 sm:col-start-2 sm:row-start-1 sm:mt-0 sm:justify-end"
			>
				{@render actions()}
			</div>
		{/if}
	</div>
</header>
