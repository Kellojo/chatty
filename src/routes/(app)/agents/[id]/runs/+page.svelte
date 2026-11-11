<script lang="ts">
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import AgentHeader from '$lib/components/app/AgentHeader.svelte';
	import AgentRunStatus from '$lib/components/app/AgentRunStatus.svelte';
	import AgentRunSummary from '$lib/components/app/AgentRunSummary.svelte';
	import EmptyState from '$lib/components/app/EmptyState.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import {
		formatDurationMs,
		formatRunDuration,
		formatRunError,
		isStoppedRun,
		RUN_TRIGGER_LABELS
	} from '$lib/agent-labels.js';
	import {
		matchesFilter,
		runStatusWord,
		summarizeRuns,
		type RunFilter
	} from '$lib/agent-run-summary.js';
	import { formatDateTime, formatTime, formatTimeAgo } from '$lib/datetime.js';
	import { onServerEvent } from '$lib/state/events.svelte.js';
	import type { AgentRun } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let stopBusy = $state<string | null>(null);
	let filter = $state<RunFilter>('all');
	let historyEl = $state<HTMLElement>();

	/** From the summary's "Show failed runs" / "Show all runs": filter, then bring the list into view. */
	async function showFiltered(next: RunFilter) {
		filter = next;
		await tick();
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		historyEl?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
		historyEl
			?.querySelector<HTMLElement>(`[data-filter="${next}"]`)
			?.focus({ preventScroll: true });
	}

	const counts = $derived(summarizeRuns(data.runs).counts);
	const visible = $derived(data.runs.filter((run) => matchesFilter(run, filter)));
	const FILTERS: { key: RunFilter; label: string }[] = [
		{ key: 'all', label: 'All' },
		{ key: 'attention', label: 'Active' },
		{ key: 'failed', label: 'Failed' },
		{ key: 'success', label: 'Succeeded' }
	];
	// Ticks while a run is going, so its elapsed time stays current.
	let now = $state(Date.now());
	$effect(() => {
		if (!data.runs.some((run) => run.status === 'running')) return;
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});

	const FILTER_EMPTY: Record<RunFilter, string> = {
		all: 'No runs',
		attention: 'Nothing running or waiting for you',
		failed: 'No failed runs',
		success: 'No successful runs'
	};

	// Runs of this agent starting, asking or finishing elsewhere refresh the list.
	$effect(() => {
		const agentId = data.agent.id;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const off = onServerEvent((event) => {
			if (
				event.type !== 'agent.run.started' &&
				event.type !== 'agent.run.awaiting_input' &&
				event.type !== 'agent.run.finished'
			) {
				return;
			}
			if (event.agentId !== agentId) return;
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				void invalidateAll();
			}, 300);
		});
		return () => {
			off();
			if (timer) clearTimeout(timer);
		};
	});

	/** Stops a running run, or dismisses the question of one waiting for you (same endpoint). */
	async function stopRun(run: AgentRun) {
		const dismiss = run.status === 'awaiting_input';
		stopBusy = run.id;
		try {
			const res = await fetch(`/api/agent-runs/${run.id}/stop`, { method: 'POST' });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				toast.error(
					body?.message ?? (dismiss ? 'Failed to dismiss question' : 'Failed to stop run')
				);
				return;
			}
			toast.success(dismiss ? 'Question dismissed' : 'Stop requested');
			await invalidateAll();
		} finally {
			stopBusy = null;
		}
	}

	/**
	 * Where a run's transcript lives: its chat (runs that can ask you things), the
	 * run page, or nowhere once its chat was deleted. A run that's still going has
	 * its run page even before a conversation is linked.
	 */
	function transcriptOf(run: AgentRun): 'chat' | 'run' | 'removed' {
		const where = data.transcripts[run.id] ?? 'run';
		return where === 'removed' && run.status === 'running' ? 'run' : where;
	}

	/** The row's link target, or null when the transcript is gone. */
	function runHref(run: AgentRun): string | null {
		const where = transcriptOf(run);
		if (where === 'removed') return null;
		return where === 'chat' && run.conversationId
			? resolve(`/chat/${run.conversationId}`)
			: resolve(`/agents/${data.agent.id}/runs/${run.id}`);
	}

	/**
	 * Runs are grouped under Today, Yesterday, the last 7 days, then by
	 * month. Only Today and Yesterday rows show just the time; older rows carry
	 * their date, so a daily agent doesn't get a heading above every run.
	 */
	function groupLabel(timestamp: number): string {
		const day = new Date(timestamp);
		const today = new Date();
		const diff = daysAgo(timestamp);
		if (diff <= 1) return dayLabel(timestamp);
		if (diff < 7) return 'Last 7 days';
		const month = day.toLocaleDateString(undefined, {
			month: 'long',
			...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' })
		});
		const thisMonth =
			day.getFullYear() === today.getFullYear() && day.getMonth() === today.getMonth();
		return thisMonth ? `Earlier in ${month}` : month;
	}

	function daysAgo(timestamp: number): number {
		const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
		return Math.round((startOf(new Date()) - startOf(new Date(timestamp))) / 86_400_000);
	}

	function dayLabel(timestamp: number): string {
		const day = new Date(timestamp);
		const today = new Date();
		const diff = daysAgo(timestamp);
		if (diff === 0) return 'Today';
		if (diff === 1) return 'Yesterday';
		return day.toLocaleDateString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' })
		});
	}
</script>

{#snippet filters()}
	<div class="flex flex-wrap gap-1" role="group" aria-label="Filter runs">
		{#each FILTERS as f (f.key)}
			{#if f.key === 'all' || counts[f.key] > 0 || filter === f.key}
				<Button
					variant={filter === f.key ? 'default' : 'outline'}
					size="sm"
					class="h-8 gap-1.5 px-2.5 text-xs"
					aria-pressed={filter === f.key}
					data-filter={f.key}
					onclick={() => (filter = f.key)}
				>
					{f.label}
					<span class="tabular-nums opacity-70">{counts[f.key]}</span>
				</Button>
			{/if}
		{/each}
	</div>
{/snippet}

<svelte:head><title>Runs · {data.agent.name} · Chatty</title></svelte:head>

<div class="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto">
	<div class="mx-auto w-full max-w-6xl p-4 md:p-6">
		<div class="flex w-full flex-col gap-6">
			<AgentHeader agent={data.agent} active="runs" />

			<!-- With only a few runs the list says it all. -->
			{#if data.runs.length >= 5}
				<AgentRunSummary
					runs={data.runs}
					timeFormat={data.timeFormat}
					hrefOf={runHref}
					{filter}
					onfilter={showFiltered}
				/>
			{/if}

			<div bind:this={historyEl} class="scroll-mt-4">
				<SettingsSection
					flush
					class="overflow-clip"
					title={data.runs.length > 0 ? 'History' : undefined}
					description={data.runs.length >= 50 ? 'Showing the 50 most recent runs.' : undefined}
					action={data.runs.length > 0 ? filters : undefined}
				>
					{#if data.runs.length === 0}
						<EmptyState
							icon={HistoryIcon}
							title="No runs yet"
							description="Runs show up here when the agent is triggered or run manually."
						/>
					{:else if visible.length === 0}
						<p class="px-(--card-spacing) py-8 text-center text-sm text-muted-foreground">
							{FILTER_EMPTY[filter]} in the last {data.runs.length} runs.
							<Button variant="link" class="h-auto p-0" onclick={() => (filter = 'all')}>
								Show all runs
							</Button>
						</p>
					{:else}
						<ul class="divide-y divide-border/60" aria-label="Runs">
							{#each visible as run, i (run.id)}
								{@const took = formatRunDuration(run)}
								{@const day = dayLabel(run.startedAt)}
								{@const group = groupLabel(run.startedAt)}
								{@const dated = daysAgo(run.startedAt) > 1}
								{#if i === 0 || group !== groupLabel(visible[i - 1].startedAt)}
									<li
										class="sticky top-0 z-20 border-b-0 bg-card px-(--card-spacing) pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
										role="presentation"
									>
										<h3>{group}</h3>
									</li>
								{/if}
								{@const error = formatRunError(run.error)}
								{@const transcript = transcriptOf(run)}
								{@const when = `${formatDateTime(run.startedAt, data.timeFormat)} · ${formatTimeAgo(run.startedAt)}`}
								{@const href = runHref(run)}
								{@const label = `run of ${day}, ${formatTime(run.startedAt, data.timeFormat)}`}
								<li
									class="relative flex flex-wrap items-center gap-x-3 gap-y-2 px-(--card-spacing) py-3 {href
										? 'hover:bg-accent/40 has-[a.row-link:focus-visible]:bg-accent/40 has-[a.row-link:focus-visible]:ring-2 has-[a.row-link:focus-visible]:ring-ring has-[a.row-link:focus-visible]:ring-inset'
										: ''}"
								>
									<AgentRunStatus status={run.status} stopped={isStoppedRun(run)} />
									<div class="flex min-w-0 flex-1 flex-col gap-0.5">
										{#if !href}
											<span class="text-sm font-medium" title={when}>
												<span class={dated ? '' : 'sr-only'}>{`${day} · `}</span>{formatTime(
													run.startedAt,
													data.timeFormat
												)}
											</span>
										{:else}
											<!-- eslint-disable svelte/no-navigation-without-resolve -- resolved in runHref -->
											<a
												{href}
												aria-describedby="run-{run.id}-details"
												class="row-link text-sm font-medium outline-none after:absolute after:inset-0 after:content-['']"
												title={when}
											>
												<!-- eslint-enable svelte/no-navigation-without-resolve -->
												<span class={dated ? '' : 'sr-only'}>{`${day} · `}</span>{formatTime(
													run.startedAt,
													data.timeFormat
												)}<span class="sr-only">, {runStatusWord(run)}</span>
											</a>
										{/if}
										<div id="run-{run.id}-details" class="contents">
											<p class="truncate text-xs text-muted-foreground">
												{RUN_TRIGGER_LABELS[run.trigger] ?? run.trigger}
												{#if data.showUser}· by {data.users[run.userId] ?? run.userId}{/if}
												{#if transcript === 'chat'}· in chat{/if}
												{#if took}<span class="sm:hidden">· {took}</span>{/if}
											</p>
											{#if !href}
												<p class="text-xs text-muted-foreground">Transcript removed</p>
											{/if}
											{#if run.status === 'running'}
												<p class="text-xs text-info-foreground tabular-nums">
													Running · {formatDurationMs(now - run.startedAt)}
												</p>
											{/if}
											{#if run.status === 'awaiting_input'}
												<p class="text-xs font-medium text-warning-foreground">
													Waiting for your reply
												</p>
											{:else if run.status === 'dismissed' && !error}
												<p class="text-xs text-muted-foreground">Question dismissed</p>
											{/if}
											{#if error}
												<p
													class="line-clamp-2 text-xs sm:line-clamp-1 {isStoppedRun(run)
														? 'text-muted-foreground'
														: 'text-destructive'}"
													title={error}
												>
													{error}
												</p>
											{/if}
										</div>
									</div>
									{#if run.status === 'running' || run.status === 'awaiting_input'}
										{@const dismiss = run.status === 'awaiting_input'}
										<!-- Above the row link's click target; a question's actions wrap below the text on phones. -->
										<div
											class="relative z-10 flex shrink-0 gap-2 {dismiss
												? 'max-sm:order-last max-sm:basis-full max-sm:pl-11'
												: ''}"
										>
											{#if dismiss && href}
												<Button {href} size="sm" aria-label="Reply to {label}">Reply</Button>
											{/if}
											<Button
												variant={dismiss ? 'ghost' : 'outline'}
												size="sm"
												disabled={stopBusy === run.id}
												aria-label="{dismiss ? 'Dismiss' : 'Stop'} {label}"
												onclick={() => stopRun(run)}
											>
												{#if stopBusy === run.id}
													{dismiss ? 'Dismissing…' : 'Stopping…'}
												{:else}
													{dismiss ? 'Dismiss' : 'Stop'}
												{/if}
											</Button>
										</div>
									{/if}
									<!-- One right-aligned column, so durations line up under each other. -->
									{#if took}
										<span
											class="hidden min-w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:inline"
											title="Duration">{took}</span
										>
									{/if}
									{#if href}
										<ChevronRightIcon
											class="size-4 shrink-0 text-muted-foreground"
											aria-hidden="true"
										/>
									{:else}
										<!-- Keeps durations aligned with the rows that have a chevron. -->
										<span class="size-4 shrink-0" aria-hidden="true"></span>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</SettingsSection>
			</div>
		</div>
	</div>
</div>
