<script lang="ts" module>
	export type MemoryConnection = {
		id: string;
		scope: 'user' | 'shared';
		path: string;
		title: string;
		folder: string;
		/** `link`: one links to the other; `tag`: they share a tag. */
		kind: 'link' | 'tag';
	};
</script>

<script lang="ts">
	import { markMemoryLinksRelative, resolveMemoryLink } from '$lib/memory-links.js';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import NetworkIcon from '@lucide/svelte/icons/network';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import LinkIcon from '@lucide/svelte/icons/link';
	import TagIcon from '@lucide/svelte/icons/tag';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import Markdown from '$lib/components/ai/markdown/markdown.svelte';
	import { formatTimeAgo } from '$lib/datetime.js';

	let {
		path,
		scope,
		title,
		description,
		type,
		tags,
		body,
		timestamp,
		knownPaths,
		connections,
		onback,
		onedit,
		ondelete,
		onshowmap,
		onnavigate,
		onopenconnection
	}: {
		path: string;
		scope: 'user' | 'shared';
		title: string;
		description: string;
		type: string;
		tags: string[];
		body: string;
		timestamp: string;
		/** Every memory path in this scope, to resolve links between memories. */
		knownPaths: Set<string>;
		connections: MemoryConnection[];
		onback: () => void;
		onedit: () => void;
		ondelete: () => void;
		onshowmap?: () => void;
		/** Opens another memory of the same scope. */
		onnavigate: (path: string) => void;
		onopenconnection: (connection: MemoryConnection) => void;
	} = $props();

	const folders = $derived(path.split('/').slice(0, -1));
	const updated = $derived(timestamp ? new Date(timestamp) : null);
	const links = $derived(connections.filter((c) => c.kind === 'link'));
	const related = $derived(connections.filter((c) => c.kind === 'tag'));

	// Links between memories are relative `.md` paths: open them here instead of
	// letting the browser navigate to a URL that doesn't exist.
	function onBodyClick(event: MouseEvent) {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
		const anchor = (event.target as Element | null)?.closest('a');
		const href = anchor?.getAttribute('href');
		if (!href || !/\.md(?:[#?].*)?$/i.test(href) || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
		event.preventDefault();
		const target = resolveMemoryLink(path, href, knownPaths);
		if (target) onnavigate(target);
		else toast.error('That memory no longer exists');
	}
</script>

<article class="flex flex-col gap-6">
	<header class="flex flex-col gap-3">
		<div class="flex items-center gap-2">
			<Button
				variant="ghost"
				size="sm"
				class="-ml-2 text-muted-foreground md:hidden"
				onclick={onback}
			>
				<ArrowLeftIcon class="size-4" />All memories
			</Button>
			<nav
				class="hidden min-w-0 items-center gap-1 text-xs text-muted-foreground md:flex"
				aria-label="Location"
			>
				<span class="shrink-0">{scope === 'shared' ? 'Shared' : 'My memory'}</span>
				{#each folders as folder, i (i)}
					<ChevronRightIcon class="size-3 shrink-0 opacity-60" />
					<span class="truncate">{folder}</span>
				{/each}
			</nav>
			<div class="ml-auto flex shrink-0 items-center gap-1">
				{#if onshowmap}
					<Button
						variant="ghost"
						size="icon"
						class="text-muted-foreground"
						title="Show on map"
						aria-label="Show on map"
						onclick={onshowmap}
					>
						<NetworkIcon class="size-4" />
					</Button>
				{/if}
				<Button
					variant="ghost"
					size="icon"
					class="text-muted-foreground hover:text-destructive"
					title="Delete memory"
					aria-label="Delete memory"
					onclick={ondelete}
				>
					<Trash2Icon class="size-4" />
				</Button>
				<Button variant="outline" size="sm" onclick={onedit} title="Edit (E)">
					<PencilIcon class="size-4" />Edit
				</Button>
			</div>
		</div>

		<div class="flex flex-col gap-1.5">
			<h2 class="text-2xl font-semibold tracking-tight text-balance break-words">
				{title || path}
			</h2>
			{#if description}
				<p class="text-pretty text-muted-foreground">{description}</p>
			{/if}
		</div>

		<div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
			{#if type}
				<span class="rounded-md bg-secondary px-1.5 py-0.5 font-medium text-secondary-foreground"
					>{type}</span
				>
			{/if}
			{#each tags as tag (tag)}
				<span class="inline-flex items-center gap-1"><TagIcon class="size-3" />{tag}</span>
			{/each}
			{#if updated}
				<span class="ml-auto" title={updated.toLocaleString()}
					>Updated {formatTimeAgo(updated.getTime())}</span
				>
			{/if}
		</div>
	</header>

	<!-- Intercepts clicks on the links inside; the links themselves stay keyboard-reachable. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="rounded-2xl border bg-card px-5 py-4 md:px-7 md:py-6" onclick={onBodyClick}>
		{#if body.trim()}
			<Markdown content={markMemoryLinksRelative(body)} class="text-[15px]" />
		{:else}
			<p class="text-sm text-muted-foreground">
				This memory has no content yet. <button
					type="button"
					class="text-foreground underline underline-offset-4"
					onclick={onedit}>Write some</button
				>
			</p>
		{/if}
	</div>

	{#if links.length || related.length}
		<section class="flex flex-col gap-3" aria-labelledby="mem-connections">
			<h3 id="mem-connections" class="text-sm font-medium">Connected memories</h3>
			<ul class="grid gap-2 sm:grid-cols-2">
				{#each [...links, ...related] as c (c.id)}
					<li>
						<button
							type="button"
							class="flex w-full items-center gap-2.5 rounded-xl border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/50"
							onclick={() => onopenconnection(c)}
						>
							{#if c.kind === 'link'}
								<LinkIcon class="size-3.5 shrink-0 text-muted-foreground" />
							{:else}
								<TagIcon class="size-3.5 shrink-0 text-muted-foreground" />
							{/if}
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm">{c.title}</span>
								<span class="block truncate text-xs text-muted-foreground">
									{c.folder || 'Top level'} · {c.kind === 'link' ? 'Linked' : 'Shares a tag'}
								</span>
							</span>
						</button>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</article>
