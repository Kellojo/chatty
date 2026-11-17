<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import AgentRunStatus from '$lib/components/app/AgentRunStatus.svelte';
	import AnimatedNumber, { type NumberFormatKind } from '$lib/components/app/AnimatedNumber.svelte';
	import { isStoppedRun } from '$lib/agent-labels.js';
	import AnimatedElapsed from '$lib/components/app/AnimatedElapsed.svelte';
	import {
		matchesFilter,
		runStatusWord,
		summarizeRuns,
		type RunFilter
	} from '$lib/agent-run-summary.js';
	import { formatDateTime, formatTimeAgo, timeAgoParts } from '$lib/datetime.js';
	import type { TimeFormat } from '$lib/user-settings.js';
	import type { AgentRun } from '$lib/types.js';

	/** The page loads at most this many runs. */
	const SLOTS = 50;

	let {
		runs,
		timeFormat,
		hrefOf,
		filter,
		onfilter
	}: {
		runs: AgentRun[];
		timeFormat: TimeFormat;
		/** Where a run opens; null when its transcript is gone. */
		hrefOf: (run: AgentRun) => string | null;
		/** The list's filter: runs it hides are dimmed in the strip. */
		filter: RunFilter;
		/** Sets the runs list's filter (the Failed stat toggles failures). */
		onfilter: (filter: RunFilter) => void;
	} = $props();

	const summary = $derived(summarizeRuns(runs));
	// The newest run that's done: a running one is already the list's first row.
	const last = $derived(
		runs.find((run) => run.status !== 'running' && run.status !== 'awaiting_input')
	);
	const lastAgo = $derived(last ? timeAgoParts(last.startedAt) : null);
	// Only recent failures turn the count red; an old one isn't news.
	const recentFailure = $derived(runs.slice(0, 5).some((run) => matchesFilter(run, 'failed')));
	// Oldest first, so the strip reads left to right like a timeline.
	const timeline = $derived([...runs].reverse().slice(-SLOTS));

	function tickTone(run: AgentRun): string {
		// Failures are full height, so they stand out by shape as well as colour.
		if (run.status === 'success') return 'h-4 bg-success/70 dark:bg-success/80';
		if (run.status === 'running') return 'h-5 bg-info';
		if (run.status === 'awaiting_input') return 'h-5 bg-warning';
		if (run.status === 'dismissed' || isStoppedRun(run)) return 'h-4 bg-muted-foreground/40';
		return 'h-7 bg-destructive';
	}
</script>

{#snippet stat(
	label: string,
	value: number | string | null,
	hint?: string,
	format?: NumberFormatKind
)}
	<div class="flex min-w-0 flex-col gap-1">
		<dt class="text-xs font-medium text-muted-foreground">{label}</dt>
		<dd class="truncate text-xl font-semibold tabular-nums">
			<AnimatedNumber {value} {format} />
		</dd>
		{#if hint}<dd class="truncate text-xs text-muted-foreground">{hint}</dd>{/if}
	</div>
{/snippet}

<Card.Root class="gap-5 rounded-2xl">
	<Card.Content class="flex flex-col gap-5">
		<dl class="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
			{@render stat(
				'Success rate',
				summary.successRate === null ? null : Math.round(summary.successRate * 100) / 100,
				summary.finished > 0
					? `${summary.succeeded} of ${summary.finished} finished runs`
					: 'No finished runs yet',
				'percent'
			)}
			<div class="flex min-w-0 flex-col gap-1">
				<dt class="text-xs font-medium text-muted-foreground">Typical run</dt>
				<dd class="truncate text-xl font-semibold tabular-nums">
					{#if summary.medianMs === null}—{:else}<AnimatedElapsed ms={summary.medianMs} />{/if}
				</dd>
				<dd class="truncate text-xs text-muted-foreground">
					{summary.medianMs === null
						? 'No finished runs yet'
						: `Median of ${summary.finished} runs`}
				</dd>
			</div>
			<div class="flex min-w-0 flex-col gap-1">
				<dt class="text-xs font-medium text-muted-foreground">Failed</dt>
				<dd
					class="truncate text-xl font-semibold tabular-nums {recentFailure
						? 'text-destructive'
						: ''}"
				>
					<AnimatedNumber value={summary.counts.failed} />
				</dd>
				<dd class="truncate text-xs text-muted-foreground">
					{#if summary.counts.failed > 0}
						{@const showing = filter === 'failed'}
						<button
							type="button"
							class="rounded-sm text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
							onclick={() => onfilter(showing ? 'all' : 'failed')}
						>
							{showing ? 'Show all runs' : 'Show failed runs'}
						</button>
					{:else}
						No failures in the last {runs.length} runs
					{/if}
				</dd>
			</div>
			<div class="flex min-w-0 flex-col gap-1">
				<dt class="text-xs font-medium text-muted-foreground">Last finished</dt>
				<dd
					class="truncate text-xl font-semibold"
					title={last ? formatDateTime(last.startedAt, timeFormat) : undefined}
				>
					{#if !lastAgo}—{:else if 'text' in lastAgo}{lastAgo.text}{:else}<AnimatedNumber
							value={lastAgo.value}
							suffix="{lastAgo.unit} ago"
						/>{/if}
				</dd>
				{#if !last}
					<dd class="truncate text-xs text-muted-foreground">Still running</dd>
				{:else}
					<dd><AgentRunStatus status={last.status} stopped={isStoppedRun(last)} label /></dd>
				{/if}
			</div>
		</dl>
		{#if timeline.length > 1}
			<div class="flex flex-col gap-1.5">
				<p class="sr-only">
					Last {runs.length} runs: {summary.succeeded} succeeded, {summary.counts.failed} failed, {summary.active}
					active.
				</p>
				<!-- Pointer shortcut only; the list below has the same links for keyboards. -->
				<!-- One slot per run the page can load, newest on the right: ticks keep their width and empty slots show room for more. -->
				<div
					class="grid h-7 items-end gap-0.5"
					style:grid-template-columns="repeat({SLOTS}, minmax(0, 1fr))"
					aria-hidden="true"
				>
					{#each { length: Math.max(0, SLOTS - timeline.length) }, i (i)}
						<span class="h-1 rounded-sm bg-muted/60"></span>
					{/each}
					{#each timeline as run (run.id)}
						{@const href = hrefOf(run)}
						{@const title = `${runStatusWord(run)} · ${formatDateTime(run.startedAt, timeFormat)}`}
						{#if href}
							<!-- eslint-disable svelte/no-navigation-without-resolve -- resolved in runHref -->
							<a
								{href}
								tabindex="-1"
								{title}
								class="rounded-sm hover:ring-2 hover:ring-ring/50 {tickTone(run)} {matchesFilter(
									run,
									filter
								)
									? ''
									: 'opacity-25'}"
							></a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{:else}
							<span
								{title}
								class="rounded-sm {tickTone(run)} {matchesFilter(run, filter) ? '' : 'opacity-25'}"
							></span>
						{/if}
					{/each}
				</div>
				<div
					class="flex items-center justify-between gap-4 text-xs text-muted-foreground"
					aria-hidden="true"
				>
					<span>
						{runs.length < SLOTS ? `${runs.length} runs, first ` : ''}{formatTimeAgo(
							timeline[0].startedAt
						)}
					</span>
					<span>{formatTimeAgo(timeline[timeline.length - 1].startedAt)}</span>
				</div>
			</div>
		{/if}
	</Card.Content>
</Card.Root>
