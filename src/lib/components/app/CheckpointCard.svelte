<script lang="ts">
	// A coding agent's checkpoint as a card under its reply: what changed, file by
	// file, each one opening in the file viewer with its changes shown inline.
	import { getContext } from 'svelte';
	import FileDiffIcon from '@lucide/svelte/icons/file-diff';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { Button } from '$lib/components/ui/button/index.js';
	import {
		diffBlocks,
		readCheckpoint,
		type CheckpointFile,
		type CheckpointFileKind
	} from '$lib/coding-checkpoint.js';
	import {
		CODING_FILES_CONTEXT,
		splitFilePath,
		type CodingFilesViewer
	} from '$lib/coding-file-links.js';
	import { formatCount } from '$lib/formats.js';
	import type { PartLike } from './timeline.js';

	let { part }: { part: PartLike } = $props();

	/** Files listed before "Show more". */
	const COLLAPSED_FILES = 5;

	const viewer = getContext<CodingFilesViewer | undefined>(CODING_FILES_CONTEXT);
	const canOpen = $derived(!!viewer?.enabled);
	const checkpoint = $derived(readCheckpoint(part));
	let expanded = $state(false);
	/** Biggest changes first, so the collapsed list shows what matters. */
	const files = $derived(
		[...(checkpoint?.files ?? [])].sort(
			(a, b) =>
				b.additions + b.deletions - (a.additions + a.deletions) || a.path.localeCompare(b.path)
		)
	);
	const shown = $derived(expanded ? files : files.slice(0, COLLAPSED_FILES));
	const hidden = $derived(files.length - shown.length);

	const KIND: Record<CheckpointFileKind, { letter: string; label: string; tone: string }> = {
		added: {
			letter: 'A',
			label: 'Added',
			tone: 'bg-success/15 text-success-foreground'
		},
		modified: {
			letter: 'M',
			label: 'Modified',
			tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
		},
		deleted: { letter: 'D', label: 'Deleted', tone: 'bg-destructive/15 text-destructive' }
	};
	const ROW = 'group/file flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left';
	const describe = (additions: number, deletions: number) =>
		`${formatCount(additions)} ${additions === 1 ? 'line' : 'lines'} added, ${formatCount(deletions)} removed`;
	const BLOCK = { add: 'bg-success/90', del: 'bg-destructive/75', none: 'bg-muted-foreground/25' };
</script>

{#snippet blocks(additions: number, deletions: number)}
	<span class="flex gap-px" aria-hidden="true">
		{#each diffBlocks(additions, deletions) as block, i (i)}
			<!-- Fill in one after another as the card appears. -->
			<span
				class="size-1.5 animate-in rounded-[2px] duration-300 fade-in-0 fill-mode-backwards zoom-in-50 motion-reduce:animate-none {BLOCK[
					block
				]}"
				style:animation-delay="{150 + i * 60}ms"
			></span>
		{/each}
	</span>
{/snippet}

{#snippet counts(additions: number, deletions: number)}
	<span class="font-mono text-xs tabular-nums" title={describe(additions, deletions)}>
		<!-- A zero reads quieter, so the real change stands out. -->
		<span class={additions ? 'text-success-foreground' : 'text-muted-foreground/60'}
			>+{formatCount(additions)}</span
		>
		<span class={deletions ? 'text-destructive' : 'text-muted-foreground/60'}
			>−{formatCount(deletions)}</span
		>
	</span>
{/snippet}

{#snippet row(file: CheckpointFile)}
	{@const kind = KIND[file.kind]}
	{@const parts = splitFilePath(file.path)}
	<span
		class="flex size-5 shrink-0 items-center justify-center rounded font-mono text-[11px] font-semibold {kind.tone}"
		title={kind.label}
		><span aria-hidden="true">{kind.letter}</span><span class="sr-only">{kind.label}</span></span
	>
	<!-- On phones the folder goes under the name, so same-named files stay apart. -->
	<span class="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-2">
		<span
			class="min-w-0 truncate font-mono text-xs font-medium text-foreground underline-offset-2 group-hover/file:underline"
			>{parts.name}</span
		>
		{#if parts.dir}
			<span
				class="min-w-0 truncate text-left font-mono text-[11px] text-muted-foreground [direction:rtl] sm:text-xs"
				><bdi>{parts.dir}</bdi></span
			>
		{/if}
	</span>
	<span class="ml-auto flex shrink-0 items-center gap-2">
		{#if file.additions + file.deletions > 0}
			{@render counts(file.additions, file.deletions)}
			<span class="max-sm:hidden">{@render blocks(file.additions, file.deletions)}</span>
		{:else}
			<span class="text-xs text-muted-foreground">No line changes</span>
		{/if}
		{#if canOpen}
			<ArrowUpRightIcon
				class="size-3.5 text-muted-foreground opacity-75 transition group-hover/file:translate-x-0.5 group-hover/file:-translate-y-0.5 group-hover/file:opacity-100 group-focus-visible/file:opacity-100"
				aria-hidden="true"
			/>
		{/if}
	</span>
{/snippet}

{#if checkpoint}
	{@const fileCount = checkpoint.files.length}
	<section
		class="w-full animate-in overflow-hidden rounded-xl border bg-card text-sm shadow-xs duration-300 fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none"
		aria-label="Checkpoint: {fileCount} {fileCount === 1 ? 'file' : 'files'} changed, {describe(
			checkpoint.additions,
			checkpoint.deletions
		)}"
	>
		<!-- The share of added vs removed lines, as a strip along the card's top edge. -->
		<div class="flex h-1 bg-muted" aria-hidden="true">
			<!-- No line changes (binary files only): the strip stays neutral. -->
			<span class="grow-in flex" style:flex-grow={checkpoint.additions + checkpoint.deletions}>
				<span class="bg-success/80" style:flex-grow={checkpoint.additions}></span>
				<span class="bg-destructive/65" style:flex-grow={checkpoint.deletions}></span>
			</span>
		</div>
		<header
			class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-linear-to-br from-success/20 via-success/5 to-transparent px-3 py-3 dark:from-success/15"
		>
			<span
				class="rounded-lgbg-success flex size-9 shrink-0 items-center justify-center text-background shadow-sm ring-4 ring-success/15"
				aria-hidden="true"
			>
				<FileDiffIcon class="size-4.5" />
			</span>
			<div class="min-w-0 flex-1">
				<p class="font-semibold text-foreground">Checkpoint</p>
				<p class="text-xs whitespace-nowrap text-muted-foreground">
					{fileCount}
					{fileCount === 1 ? 'file' : 'files'} changed
				</p>
			</div>
			<!-- The totals get the header's weight; the blocks echo each row's. -->
			<div class="flex shrink-0 items-center gap-2" aria-hidden="true">
				<span class="font-mono text-base font-semibold tabular-nums">
					<span class="text-success-foreground">+{formatCount(checkpoint.additions)}</span>
					<span class="text-destructive">−{formatCount(checkpoint.deletions)}</span>
				</span>
				{@render blocks(checkpoint.additions, checkpoint.deletions)}
			</div>
			{#if canOpen && viewer?.openChanges}
				<Button
					variant="outline"
					size="sm"
					class="shrink-0 bg-background/80 max-sm:basis-full"
					onclick={() => viewer.openChanges?.()}
				>
					<FileDiffIcon />
					Review all changes
				</Button>
			{/if}
		</header>
		<ul class="divide-y">
			{#each shown as file (file.path)}
				<li
					class={file.kind === 'added'
						? 'bg-success/[0.04]'
						: file.kind === 'deleted'
							? 'bg-destructive/[0.04]'
							: undefined}
				>
					{#if canOpen}
						<button
							type="button"
							class="{ROW} cursor-pointer transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset"
							title="Open {file.path}"
							aria-label="Open {file.path}, {KIND[file.kind].label.toLowerCase()}, {describe(
								file.additions,
								file.deletions
							)}"
							onclick={() =>
								viewer?.open({ path: file.path, line: null, endLine: null, fromCheckpoint: true })}
							>{@render row(file)}</button
						>
					{:else}
						<div class={ROW} title={file.path}>{@render row(file)}</div>
					{/if}
				</li>
			{/each}
		</ul>
		{#if hidden > 0 || expanded}
			<button
				type="button"
				class="flex w-full items-center justify-center gap-1 border-t px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset"
				aria-expanded={expanded}
				onclick={() => (expanded = !expanded)}
			>
				{expanded ? 'Show fewer' : `Show ${hidden} more ${hidden === 1 ? 'file' : 'files'}`}
				<ChevronDownIcon
					class="size-3.5 transition {expanded ? 'rotate-180' : ''}"
					aria-hidden="true"
				/>
			</button>
		{/if}
	</section>
{/if}

<style>
	/* The ratio strip draws itself in from the left as the card appears. */
	.grow-in {
		transform-origin: left;
		animation: grow-in 700ms cubic-bezier(0.22, 1, 0.36, 1) 120ms both;
	}
	@keyframes grow-in {
		from {
			transform: scaleX(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.grow-in {
			animation: none;
		}
	}
</style>
