<script lang="ts">
	import { resolve } from '$app/paths';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import BookmarkPlusIcon from '@lucide/svelte/icons/bookmark-plus';
	import PencilLineIcon from '@lucide/svelte/icons/pencil-line';
	import EraserIcon from '@lucide/svelte/icons/eraser';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import UsersIcon from '@lucide/svelte/icons/users';
	import type { Component } from 'svelte';
	import WidgetCard from './widget-card.svelte';

	/**
	 * A ```memory fence: a quiet receipt for long-term memory writes
	 * (create_concept / update_concept / delete_concept), so the user sees
	 * what the assistant remembered. One card can carry several writes.
	 */
	type Action = 'created' | 'updated' | 'deleted';
	type Item = {
		action: Action;
		path: string;
		title: string;
		snippet: string | null;
		shared: boolean;
	};

	type Props = {
		code: string;
		isIncomplete: boolean;
	};

	let { code, isIncomplete }: Props = $props();

	const rec = (v: unknown): Record<string, unknown> | null =>
		typeof v === 'object' && v !== null && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: null;
	const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

	const ACTIONS: Record<string, Action> = {
		created: 'created',
		create: 'created',
		remembered: 'created',
		updated: 'updated',
		update: 'updated',
		deleted: 'deleted',
		delete: 'deleted',
		forgot: 'deleted'
	};

	/** "people/jane-doe.md" → "Jane Doe", for items without a title. */
	function titleFromPath(path: string): string {
		const name = (path.split('/').pop() ?? path).replace(/\.md$/i, '').replace(/[-_]+/g, ' ');
		return name.replace(/\b\w/g, (c) => c.toUpperCase());
	}

	function parseItem(v: unknown): Item | null {
		const r = rec(v);
		const path = str(r?.path);
		if (!r || !path) return null;
		return {
			action: ACTIONS[String(r.action ?? '').toLowerCase()] ?? 'updated',
			path,
			title: str(r.title) ?? titleFromPath(path),
			snippet: str(r.snippet) ?? str(r.description),
			shared: r.scope === 'shared'
		};
	}

	const items = $derived.by((): Item[] | null => {
		if (isIncomplete) return null;
		try {
			const parsed: unknown = JSON.parse(code);
			const list = Array.isArray(parsed) ? parsed : (rec(parsed)?.items ?? [parsed]);
			if (!Array.isArray(list)) return null;
			const out = list.map(parseItem).filter((i): i is Item => i !== null);
			return out.length ? out : null;
		} catch {
			return null;
		}
	});

	const STYLE: Record<
		Action,
		{ label: string; icon: Component<{ class?: string }>; tile: string }
	> = {
		created: {
			label: 'Remembered',
			icon: BookmarkPlusIcon,
			tile: 'bg-violet-500/10 text-violet-600 dark:bg-violet-400/20 dark:text-violet-300'
		},
		updated: {
			label: 'Updated',
			icon: PencilLineIcon,
			tile: 'bg-sky-500/10 text-sky-600 dark:bg-sky-400/20 dark:text-sky-300'
		},
		deleted: {
			label: 'Forgot',
			icon: EraserIcon,
			tile: 'bg-foreground/[0.06] text-muted-foreground'
		}
	};

	const memoryHref = resolve('/memory');
	/** A forgotten concept is gone from the memory page, so "open" would overpromise. */
	const allForgotten = $derived(items?.every((i) => i.action === 'deleted') ?? false);

	const SUMMARY_WORDS: Record<Action, string> = {
		created: 'remembered',
		updated: 'updated',
		deleted: 'forgotten'
	};
	/** "2 remembered · 1 updated · 1 forgotten" for the multi-write footer. */
	const summary = $derived(
		(['created', 'updated', 'deleted'] as const)
			.map((a) => [a, items?.filter((i) => i.action === a).length ?? 0] as const)
			.filter(([, n]) => n > 0)
			.map(([a, n]) => `${n} ${SUMMARY_WORDS[a]}`)
			.join(' · ')
	);
</script>

{#snippet sharedPill(cls: string)}
	<span
		class="items-center gap-1 rounded-full bg-foreground/[0.08] px-1.5 text-[11px] leading-4 font-medium text-foreground/75 {cls}"
		title="Shared memory"><UsersIcon class="size-3" aria-hidden="true" /><span>Shared</span></span
	>
{/snippet}

{#snippet openLink(labelled: boolean)}
	{@const verb = allForgotten ? 'View' : 'Open'}
	<a
		href={memoryHref}
		aria-label="{verb} memory page"
		title="{verb} memory page"
		class="inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center gap-1 self-center rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
	>
		{#if labelled}
			<span>{verb} memory</span>
		{:else}
			<span class="@md:hidden">{verb}</span><span class="hidden @md:inline">{verb} memory</span>
		{/if}
		<ArrowUpRightIcon class="size-3.5" aria-hidden="true" />
	</a>
{/snippet}

<WidgetCard
	icon={BrainIcon}
	status={items ? 'ready' : isIncomplete ? 'loading' : 'error'}
	loadingLabel="Saving to memory…"
	errorLabel="Could not show this memory"
	raw={code}
	class="@container"
>
	{#if items}
		<ul
			class="flex flex-col pt-1.5 {items.length > 1 ? 'pb-2.5' : 'pb-1.5'}"
			aria-label="Memory changes"
		>
			{#each items as item, i (`${item.path}:${i}`)}
				{@const style = STYLE[item.action]}
				{@const Icon = style.icon}
				<li
					class="flex min-w-0 items-start gap-3 py-1.5 pl-4 {items.length === 1 ? 'pr-2' : 'pr-4'}"
				>
					<div
						class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg {style.tile}"
						aria-hidden="true"
					>
						<Icon class="size-4" />
					</div>
					<div class="flex min-w-0 flex-1 flex-col">
						<p class="flex min-w-0 items-baseline gap-1.5 text-sm leading-5">
							<span class="shrink-0 text-muted-foreground">{style.label}</span>
							<span
								class="truncate font-medium {item.action === 'deleted'
									? 'text-muted-foreground line-through decoration-muted-foreground/60'
									: 'text-foreground'}"
								title="{item.title} · {item.path}">{item.title}</span
							>
							{#if item.shared}
								{@render sharedPill('hidden shrink-0 self-center @md:inline-flex')}
							{/if}
						</p>
						{#if item.snippet || item.shared}
							<!-- Narrow cards: the Shared pill leads the snippet so the title keeps its room. -->
							<p
								class="text-xs leading-4 text-pretty text-muted-foreground {items.length === 1
									? 'line-clamp-3 @md:line-clamp-2'
									: 'line-clamp-2 @md:line-clamp-1'} {item.action === 'deleted'
									? 'opacity-80'
									: ''}"
								title={item.snippet}
							>
								{#if item.shared}{@render sharedPill(
										'mr-1 inline-flex align-[-3px] @md:hidden'
									)}{/if}{item.snippet ?? ''}
							</p>
						{/if}
					</div>
					{#if items.length === 1}
						{@render openLink(false)}
					{/if}
				</li>
			{/each}
		</ul>
		{#if items.length > 1}
			<div
				class="flex items-center justify-center gap-2 border-t border-border/60 py-1 pr-2 pl-4 @sm:justify-end"
			>
				{#if items.length > 2}
					<span
						class="mr-auto hidden min-w-0 truncate text-xs text-muted-foreground tabular-nums @sm:block"
						>{summary}</span
					>
				{/if}
				{@render openLink(true)}
			</div>
		{/if}
	{/if}
</WidgetCard>
