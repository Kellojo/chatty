<script lang="ts" module>
	export interface McpTestResult {
		ok: boolean;
		tools: { name: string; description?: string }[];
		error?: string;
	}

	/** Lists this long get search and the name grid. */
	const LARGE_FROM = 10;

	/**
	 * The prefix every tool name shares up to an underscore (e.g. `ha_`), shown once
	 * instead of on every tool. Empty when there is none or the list is short.
	 */
	export function sharedPrefix(names: string[]): string {
		if (names.length < 3) return '';
		let prefix = names[0];
		for (const name of names) {
			while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
			if (!prefix) return '';
		}
		const cut = prefix.lastIndexOf('_');
		prefix = cut > 0 ? prefix.slice(0, cut + 1) : '';
		// Never strip a whole name.
		return names.some((n) => n.length <= prefix.length) ? '' : prefix;
	}
</script>

<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import SearchIcon from '@lucide/svelte/icons/search';
	import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
	import XIcon from '@lucide/svelte/icons/x';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { fadeWhenScrollable } from '$lib/fade-when-scrollable.js';

	let {
		open = $bindable(false),
		serverName,
		result,
		expectedTools = null,
		busy = false,
		onRetest
	}: {
		open?: boolean;
		serverName: string;
		/** Null while the first test runs. */
		result: McpTestResult | null;
		/** Tools the server listed last time, so the loading state already has the final size. */
		expectedTools?: number | null;
		/** A retest is running. */
		busy?: boolean;
		onRetest?: () => void;
	} = $props();

	let content = $state<HTMLElement | null>(null);
	let searchInput = $state<HTMLInputElement | null>(null);
	let query = $state('');
	let selected = $state<string | null>(null);

	// A fresh result starts unfiltered, with nothing selected.
	$effect.pre(() => {
		void result;
		query = '';
		selected = null;
	});

	const tools = $derived(result?.ok ? result.tools : []);
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return tools;
		return tools.filter(
			(t) => t.name.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q)
		);
	});
	const prefix = $derived(sharedPrefix(tools.map((t) => t.name)));
	// A tool the search hides closes with it.
	const detail = $derived(selected ? filtered.find((t) => t.name === selected) : undefined);
	const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
	// Loading is sized from the expected count, so the dialog doesn't jump when tools arrive.
	// Big lists hang from the top, so a search that shortens them only moves the bottom edge.
	// A failure sizes to its message instead.
	const large = $derived(
		result ? result.ok && tools.length >= LARGE_FROM : (expectedTools ?? LARGE_FROM) >= LARGE_FROM
	);
	const skeletonCells = $derived(Math.min(expectedTools ?? 24, 80));
	const skeletonRows = $derived(Math.max(1, Math.min(expectedTools ?? 3, LARGE_FROM - 1)));
	const announcement = $derived(
		!result
			? 'Testing connection'
			: result.ok
				? `Connected. ${plural(tools.length, 'tool')} available.`
				: `Couldn't connect. ${result.error ?? ''}`
	);
	/** What to check, by the kind of failure. */
	const hint = $derived.by(() => {
		const error = result?.error ?? '';
		if (/\b(401|403)\b|unauthori[sz]ed|forbidden|sign in|token/i.test(error))
			return 'The server rejected the credentials. Check the token or sign in again.';
		if (/timed out|timeout|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed/i.test(error))
			return "The server didn't answer. Check its address and that it's running.";
		return "Check the server's address and credentials, and that it's running.";
	});
	/** Splits ``code`` and `code` spans (common in tool descriptions) from plain text. */
	function segments(text: string): { code: boolean; text: string }[] {
		const out: { code: boolean; text: string }[] = [];
		const re = /``([^`]+)``|`([^`]+)`/g;
		let last = 0;
		for (const m of text.matchAll(re)) {
			if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
			out.push({ code: true, text: m[1] ?? m[2] });
			last = m.index + m[0].length;
		}
		if (last < text.length) out.push({ code: false, text: text.slice(last) });
		return out;
	}
	/** First sentence, for a name's hover hint. */
	const summary = (text?: string) => text?.replace(/``?/g, '').split(/(?<=\.)\s/)[0] ?? '';
	function clearSearch() {
		query = '';
		searchInput?.focus();
	}
	const bone = (size: string) =>
		`animate-pulse rounded bg-foreground/8 motion-reduce:animate-none ${size}`;
</script>

{#snippet description(text: string)}
	{#each segments(text) as seg, i (i)}{#if seg.code}<code
				class="rounded bg-foreground/8 px-1 font-mono text-[11px] text-foreground/85"
				>{seg.text}</code
			>{:else}{seg.text}{/if}{/each}
{/snippet}

{#snippet search(disabled: boolean)}
	<div class="relative shrink-0">
		<SearchIcon
			class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
			aria-hidden="true"
		/>
		<Input
			bind:ref={searchInput}
			type="search"
			bind:value={query}
			{disabled}
			placeholder="Search tools"
			aria-label="Search tools"
			autocomplete="off"
			class="pr-10 pl-9 disabled:opacity-60 [&::-webkit-search-cancel-button]:hidden"
			onkeydown={(e) => {
				// Escape clears the search first, and only then closes the dialog.
				if (e.key === 'Escape' && query) {
					e.preventDefault();
					e.stopPropagation();
					query = '';
				}
			}}
		/>
		{#if query}
			<button
				type="button"
				class="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				aria-label="Clear search"
				onclick={clearSearch}
			>
				<XIcon class="size-4" aria-hidden="true" />
			</button>
		{/if}
	</div>
{/snippet}

<Dialog.Root bind:open>
	<!-- Focus the dialog itself on open, not the search or the footer button. -->
	<Dialog.Content
		bind:ref={content}
		tabindex={-1}
		onOpenAutoFocus={(e) => {
			e.preventDefault();
			content?.focus();
		}}
		class="flex max-h-[92dvh] flex-col gap-4 sm:max-h-[85dvh] sm:max-w-2xl md:max-w-3xl {large
			? 'top-[4dvh] translate-y-0 sm:top-[7.5dvh]'
			: ''}"
	>
		<!-- One persistent live region: swapped-out content isn't reliably announced. -->
		<p class="sr-only" aria-live="polite">{announcement}</p>
		<Dialog.Header class="shrink-0">
			<Dialog.Title class="leading-normal font-semibold">Connection test</Dialog.Title>
			<Dialog.Description class="truncate pr-8 font-mono text-[13px]" title={serverName}>
				{serverName}
			</Dialog.Description>
		</Dialog.Header>

		<!-- Status: one compact line, so the tools get the room. -->
		<div
			class="flex min-h-11 shrink-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-sm {result?.ok
				? 'border-success/30 bg-success/8'
				: result
					? 'border-destructive/30 bg-destructive/8'
					: 'bg-muted/40'}"
			aria-busy={busy || !result}
		>
			{#if !result || busy}
				<Loader2Icon
					class="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
					aria-hidden="true"
				/>
			{:else if result.ok}
				<CircleCheckIcon class="size-4 shrink-0 text-success" aria-hidden="true" />
			{:else}
				<CircleAlertIcon class="size-4 shrink-0 text-destructive" aria-hidden="true" />
			{/if}
			<p class="min-w-0 flex-1">
				{#if !result}
					<span class="font-medium">Connecting…</span>
				{:else if result.ok}
					<span class="font-medium">{busy ? 'Testing again…' : 'Connected'}</span>
					<span class="text-foreground/80 tabular-nums">
						· {query.trim() && tools.length
							? `${filtered.length} of ${plural(tools.length, 'tool')}`
							: tools.length
								? plural(tools.length, 'tool')
								: 'no tools'}</span
					>{#if prefix}<span class="text-muted-foreground max-sm:hidden">
							&nbsp;· all start with <code class="font-mono text-[12.5px] text-foreground/80"
								>{prefix}</code
							></span
						>{/if}
				{:else}
					<span class="font-medium">{busy ? 'Testing again…' : "Couldn't connect"}</span>
				{/if}
			</p>
			{#if result && onRetest}
				<Button
					variant="ghost"
					size="sm"
					class="-my-1 shrink-0"
					disabled={busy}
					onclick={onRetest}
					aria-label="Test again"
				>
					<RotateCwIcon
						class="size-3.5 {busy ? 'animate-spin motion-reduce:animate-none' : ''}"
						aria-hidden="true"
					/>
					<span class="max-sm:hidden">Test again</span>
				</Button>
			{/if}
		</div>

		{#if !result}
			<!-- The loaded layout's shape, so nothing moves when the tools arrive. -->
			{#if large}
				<div class="shrink-0" aria-hidden="true" inert>{@render search(true)}</div>
				<div class="min-h-0 overflow-hidden" aria-hidden="true">
					<div class="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
						{#each { length: skeletonCells }, i (i)}
							<div class="flex h-8 items-center rounded-lg border px-2.5">
								<div class={bone('h-2.5')} style:width="{45 + ((i * 17) % 40)}%"></div>
							</div>
						{/each}
					</div>
				</div>
			{:else}
				<div class="overflow-hidden rounded-xl border" aria-hidden="true">
					{#each { length: skeletonRows }, i (i)}
						<div class="flex h-15 flex-col justify-center gap-1.5 border-b px-3 last:border-b-0">
							<div class={bone('h-3')} style:width="{8 + ((i * 5) % 7)}rem"></div>
							<div class={bone('h-2.5 w-4/5')}></div>
						</div>
					{/each}
				</div>
			{/if}
		{:else if result.ok && tools.length === 0}
			<p class="rounded-xl border px-3 py-6 text-center text-sm text-muted-foreground">
				The server lists no tools.
			</p>
		{:else if result.ok && large}
			{@render search(false)}
			<!-- Overview: every name at a glance; a name's description opens below. -->
			<div class="flex min-h-0 flex-1 flex-col gap-2">
				{#if filtered.length === 0}
					<div class="flex flex-col items-center gap-2 py-8 text-center">
						<p class="text-sm text-muted-foreground">No tools match “{query.trim()}”.</p>
						<Button variant="ghost" size="sm" onclick={clearSearch}>Clear search</Button>
					</div>
				{:else}
					<div
						{@attach fadeWhenScrollable}
						class="{detail
							? 'min-h-40'
							: 'min-h-0'} overflow-y-auto data-more-below:[mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]"
					>
						<ul class="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4" aria-label="Tools">
							{#each filtered as tool (tool.name)}
								{@const active = selected === tool.name}
								<li class="min-w-0">
									<button
										type="button"
										class="flex h-8 w-full items-center rounded-lg border px-2.5 text-left font-mono text-[12.5px] transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none {active
											? 'border-primary/70 bg-primary/12 text-foreground ring-1 ring-primary/40'
											: 'bg-muted/30 text-foreground/85 hover:bg-muted/70'}"
										aria-pressed={active}
										aria-controls="mcp-tool-detail"
										title={summary(tool.description) || tool.name}
										onclick={() => (selected = active ? null : tool.name)}
									>
										<span class="truncate"
											>{prefix ? tool.name.slice(prefix.length) : tool.name}</span
										>
									</button>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
				{#if detail}
					<section
						id="mcp-tool-detail"
						aria-label="About {detail.name}"
						class="flex max-h-[28dvh] shrink-0 flex-col gap-1.5 rounded-xl border bg-muted/30 px-3 py-2.5"
					>
						<div class="flex items-center gap-2">
							<h3 class="min-w-0 flex-1 truncate font-mono text-[13px] font-medium">
								{detail.name}
							</h3>
							<button
								type="button"
								class="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
								aria-label="Close details"
								onclick={() => (selected = null)}
							>
								<XIcon class="size-3.5" aria-hidden="true" />
							</button>
						</div>
						<p
							{@attach fadeWhenScrollable}
							class="min-h-0 overflow-y-auto text-xs leading-relaxed wrap-break-word whitespace-pre-line text-muted-foreground data-more-below:[mask-image:linear-gradient(to_bottom,black_calc(100%-1.25rem),transparent)]"
						>
							{#if detail.description}{@render description(detail.description)}{:else}<span
									class="italic">No description</span
								>{/if}
						</p>
					</section>
				{/if}
			</div>
		{:else if result.ok}
			<!-- Short lists show each tool with its description. -->
			<ul class="min-h-0 overflow-y-auto rounded-xl border" aria-label="Tools">
				{#each tools as tool (tool.name)}
					<li
						class="flex min-h-15 flex-col justify-center gap-0.5 border-b px-3 py-2.5 last:border-b-0"
					>
						<span class="font-mono text-[13px] leading-5 font-medium wrap-break-word"
							>{tool.name}</span
						>
						{#if tool.description}
							<p
								class="truncate text-xs leading-4 text-muted-foreground"
								title={summary(tool.description)}
							>
								{@render description(tool.description)}
							</p>
						{:else}
							<p class="text-xs leading-4 text-muted-foreground/70 italic">No description</p>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<div class="flex flex-col gap-2">
				<p class="text-sm text-muted-foreground">{hint}</p>
				<!-- Focusable so keyboards can scroll a long error. -->
				<p
					tabindex="0"
					aria-label="Error details"
					class="max-h-48 overflow-y-auto rounded-xl border bg-muted/40 px-3 py-2.5 font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap text-foreground/85 select-text focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
				>
					{result.error ?? 'Unknown error'}
				</p>
			</div>
		{/if}

		<Dialog.Footer class="shrink-0">
			<Button variant="outline" onclick={() => (open = false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
