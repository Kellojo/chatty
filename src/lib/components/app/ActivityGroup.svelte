<script lang="ts">
	import { Markdown } from '$lib/components/ai/markdown/index.js';
	import { ToolCallCard } from '$lib/components/ai/tool-call-card/index.js';
	import { cn } from '$lib/utils.js';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import { SvelteMap } from 'svelte/reactivity';
	import { formatElapsed } from '$lib/formats.js';
	import LiveElapsed from './LiveElapsed.svelte';
	import {
		reasoningTiming,
		summarizeActivity,
		type IndexedPart,
		type PartLike
	} from './timeline.js';

	type Part = PartLike & { text?: string };

	let {
		items,
		live = false,
		active = false
	}: {
		items: IndexedPart<Part>[];
		/** This block is the one currently being generated. */
		live?: boolean;
		/** The message this block belongs to is still being generated. */
		active?: boolean;
	} = $props();

	/** While live only the latest steps are shown; earlier ones are one click away. */
	const LIVE_TAIL = 6;

	let userOpen = $state<boolean | null>(null);
	let showAll = $state(false);
	const openReasoning = $state<Record<number, boolean>>({});

	const summary = $derived(summarizeActivity(items));
	const expanded = $derived(userOpen ?? live);
	/** Short runs read better as plain rows than behind a summary header. */
	const inline = $derived(summary.steps <= 2 && items.length <= 3);
	const hiddenCount = $derived(
		live && !showAll && userOpen === null ? Math.max(0, items.length - LIVE_TAIL) : 0
	);
	const visible = $derived(hiddenCount > 0 ? items.slice(hiddenCount) : items);

	// A live thought without a recorded start is timed from when it first appeared.
	const firstSeen = new SvelteMap<number, number>();
	$effect(() => {
		const last = items[items.length - 1];
		if (live && last?.part.type === 'reasoning' && !firstSeen.has(last.index)) {
			firstSeen.set(last.index, Date.now());
		}
	});

	function thinkingSince(item: IndexedPart<Part>): number | null {
		return reasoningTiming(item.part).startedAt ?? firstSeen.get(item.index) ?? null;
	}

	/** "Thought for 12s" when both ends are known, else just "Thought". */
	function thoughtLabel(item: IndexedPart<Part>): string {
		const { startedAt, completedAt } = reasoningTiming(item.part);
		if (startedAt === null || completedAt === null || completedAt < startedAt) return 'Thought';
		return `Thought for ${formatElapsed(Math.max(1000, completedAt - startedAt))}`;
	}
</script>

{#snippet step(item: IndexedPart<Part>, isLast: boolean)}
	{#if item.part.type === 'reasoning'}
		{@const open = openReasoning[item.index] ?? false}
		{@const thinking = live && isLast}
		<div class="w-full min-w-0 text-sm">
			<button
				type="button"
				class="group/tool flex w-full items-center gap-2.5 rounded-md px-2 py-1 text-left text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:py-2"
				aria-expanded={open}
				onclick={() => (openReasoning[item.index] = !open)}
			>
				<span class="flex size-5 shrink-0 items-center justify-center">
					<BrainIcon class="size-3.5" />
				</span>
				{#if thinking}
					{@const since = thinkingSince(item)}
					<!-- Matches ThinkingIndicator, which this row replaces, so the handoff doesn't jump. -->
					<span class="shrink-0">
						<span class="text-shimmer font-medium">Thinking</span>
						{#if since !== null}<LiveElapsed {since} class="ml-2.5 text-xs" />{/if}
					</span>
				{:else}
					<span class="shrink-0 font-medium">{thoughtLabel(item)}</span>
				{/if}
				{#if !open}
					<span class="min-w-0 truncate text-xs text-muted-foreground">
						{item.part.text?.replace(/\s+/g, ' ').trim()}
					</span>
				{/if}
				<ChevronRightIcon
					aria-hidden="true"
					class={cn(
						'ml-auto size-3.5 shrink-0 opacity-50 transition group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100',
						open && 'rotate-90 opacity-100'
					)}
				/>
			</button>
			{#if open}
				<div class="reasoning-body mt-1 mb-2 ml-1 sm:ml-9">
					<Markdown
						class="w-full max-w-none text-sm text-muted-foreground"
						content={item.part.text ?? ''}
					/>
				</div>
			{/if}
		</div>
	{:else}
		<ToolCallCard part={item.part as never} {active} />
	{/if}
{/snippet}

{#if inline}
	<div class="-mx-2 flex w-[calc(100%+1rem)] flex-col">
		{#each items as item, i (item.index)}
			{@render step(item, i === items.length - 1)}
		{/each}
	</div>
{:else}
	<div class="-mx-2 w-[calc(100%+1rem)]">
		<button
			type="button"
			class="group/head flex w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-1 text-left text-sm text-foreground/80 transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:py-2"
			aria-expanded={expanded}
			aria-label={`${summary.title}, ${summary.steps} ${summary.steps === 1 ? 'step' : 'steps'}${summary.failed > 0 ? `, ${summary.failed} failed` : ''}`}
			onclick={() => (userOpen = !expanded)}
		>
			<span class="flex size-5 shrink-0 items-center justify-center sm:self-center">
				{#if live}
					<Loader2Icon class="size-3.5 animate-spin" />
				{:else}
					<ChevronRightIcon class={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
				{/if}
			</span>
			<span class="line-clamp-2 min-w-0 self-center font-medium sm:truncate">{summary.title}</span>
			<span
				class="hidden shrink-0 self-center text-xs text-muted-foreground/70 tabular-nums sm:inline"
			>
				<span aria-hidden="true">·</span>
				{summary.steps}
				{summary.steps === 1 ? 'step' : 'steps'}
			</span>
			{#if summary.failed > 0}
				<!-- mr-5 skips the chevron slot so the pill lines up with the rows' status column. -->
				<span
					class="mr-5 ml-auto shrink-0 self-center rounded-full bg-destructive/10 px-1.5 py-px text-[11px] font-medium text-destructive"
				>
					{summary.failed} failed
				</span>
			{/if}
		</button>
		{#if expanded}
			<div class="mt-0.5 ml-[1.0625rem] flex flex-col border-l border-border pl-1 sm:pl-2">
				{#if hiddenCount > 0}
					<button
						type="button"
						class="self-start rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
						onclick={() => (showAll = true)}
					>
						Show {hiddenCount} earlier {hiddenCount === 1 ? 'step' : 'steps'}
					</button>
				{/if}
				{#each visible as item, i (item.index)}
					{@render step(item, i === visible.length - 1)}
				{/each}
			</div>
		{/if}
	</div>
{/if}
