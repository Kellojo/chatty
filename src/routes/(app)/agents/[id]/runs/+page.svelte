<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import AgentHeader from '$lib/components/app/AgentHeader.svelte';
	import AgentRunStatus from '$lib/components/app/AgentRunStatus.svelte';
	import EmptyState from '$lib/components/app/EmptyState.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import {
		formatRunDuration,
		formatRunError,
		isStoppedRun,
		RUN_TRIGGER_LABELS
	} from '$lib/agent-labels.js';
	import { formatDateTime, formatTime, formatTimeAgo } from '$lib/datetime.js';
	import { onServerEvent } from '$lib/state/events.svelte.js';
	import type { AgentRun } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let stopBusy = $state<string | null>(null);

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

	// Runs are grouped under day headings, so each row only needs its time.
	function dayLabel(timestamp: number): string {
		const day = new Date(timestamp);
		const today = new Date();
		const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
		const diff = Math.round((startOf(today) - startOf(day)) / 86_400_000);
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

<svelte:head><title>Runs · {data.agent.name} · Chatty</title></svelte:head>

<div class="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto">
	<div class="mx-auto w-full max-w-6xl p-4 md:p-6">
		<div class="flex w-full flex-col gap-6">
			<AgentHeader agent={data.agent} active="runs" />

			<SettingsSection
				flush
				title={data.runs.length > 0 ? 'Recent runs' : undefined}
				description={data.runs.length >= 50 ? 'The 50 most recent runs.' : undefined}
			>
				{#if data.runs.length === 0}
					<EmptyState
						icon={HistoryIcon}
						title="No runs yet"
						description="Runs show up here with their status and transcript once the agent starts."
					/>
				{:else}
					<ul class="divide-y divide-border/60" aria-label="Runs">
						{#each data.runs as run, i (run.id)}
							{@const took = formatRunDuration(run)}
							{@const day = dayLabel(run.startedAt)}
							{#if i === 0 || day !== dayLabel(data.runs[i - 1].startedAt)}
								<li
									class="bg-muted/40 px-(--card-spacing) py-1.5 text-xs font-medium text-muted-foreground"
									aria-hidden="true"
								>
									{day}
								</li>
							{/if}
							{@const error = formatRunError(run.error)}
							{@const transcript = transcriptOf(run)}
							{@const when = `${formatDateTime(run.startedAt, data.timeFormat)} · ${formatTimeAgo(run.startedAt)}`}
							<li
								class="relative flex items-center gap-3 px-(--card-spacing) py-3 {transcript ===
								'removed'
									? ''
									: 'hover:bg-accent/40 has-[a:focus-visible]:bg-accent/40 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring has-[a:focus-visible]:ring-inset'}"
							>
								<AgentRunStatus status={run.status} stopped={isStoppedRun(run)} />
								<div class="flex min-w-0 flex-1 flex-col gap-0.5">
									{#if transcript === 'removed'}
										<span class="text-sm font-medium" title={when}>
											<span class="sr-only">{day}, </span>{formatTime(
												run.startedAt,
												data.timeFormat
											)}
										</span>
									{:else}
										<a
											href={transcript === 'chat' && run.conversationId
												? resolve(`/chat/${run.conversationId}`)
												: resolve(`/agents/${data.agent.id}/runs/${run.id}`)}
											class="text-sm font-medium outline-none after:absolute after:inset-0 after:content-['']"
											title={when}
										>
											<span class="sr-only">{day}, </span>{formatTime(
												run.startedAt,
												data.timeFormat
											)}
										</a>
									{/if}
									<p class="truncate text-xs text-muted-foreground">
										{RUN_TRIGGER_LABELS[run.trigger] ?? run.trigger}
										{#if took}· took {took}{:else if run.status === 'running'}· running{/if}
										{#if data.showUser}· by {data.users[run.userId] ?? run.userId}{/if}
										{#if transcript === 'chat'}· in chat{/if}
										{#if transcript === 'removed'}· Transcript removed{/if}
									</p>
									{#if error}
										<p
											class="line-clamp-2 text-xs sm:line-clamp-1 {isStoppedRun(run)
												? 'text-muted-foreground'
												: 'text-destructive/90'}"
											title={error}
										>
											{error}
										</p>
									{/if}
								</div>
								{#if run.status === 'running' || run.status === 'awaiting_input'}
									{@const dismiss = run.status === 'awaiting_input'}
									<!-- Above the row link's click target. -->
									<Button
										variant="outline"
										size="sm"
										class="relative z-10"
										disabled={stopBusy === run.id}
										onclick={() => stopRun(run)}
									>
										{#if stopBusy === run.id}
											{dismiss ? 'Dismissing…' : 'Stopping…'}
										{:else}
											{dismiss ? 'Dismiss' : 'Stop'}
										{/if}
									</Button>
								{/if}
								{#if transcript !== 'removed'}
									<ChevronRightIcon
										class="size-4 shrink-0 text-muted-foreground"
										aria-hidden="true"
									/>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</SettingsSection>
		</div>
	</div>
</div>
