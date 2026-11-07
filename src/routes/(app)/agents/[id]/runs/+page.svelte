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
	import { formatRunDuration, formatRunError, RUN_TRIGGER_LABELS } from '$lib/agent-labels.js';
	import { formatDateTime, formatTimeAgo } from '$lib/datetime.js';
	import { onServerEvent } from '$lib/state/events.svelte.js';
	import type { AgentRun } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let stopBusy = $state<string | null>(null);

	// Runs of this agent starting or finishing elsewhere refresh the list.
	$effect(() => {
		const agentId = data.agent.id;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const off = onServerEvent((event) => {
			if (event.type !== 'agent.run.started' && event.type !== 'agent.run.finished') return;
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

	async function stopRun(run: AgentRun) {
		stopBusy = run.id;
		try {
			const res = await fetch(`/api/agent-runs/${run.id}/stop`, { method: 'POST' });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				toast.error(body?.message ?? 'Failed to stop run');
				return;
			}
			toast.success('Stop requested');
			await invalidateAll();
		} finally {
			stopBusy = null;
		}
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
						{#each data.runs as run (run.id)}
							{@const took = formatRunDuration(run)}
							{@const error = formatRunError(run.error)}
							<li
								class="relative flex items-center gap-3 px-6 py-3 hover:bg-accent/40 has-[a:focus-visible]:bg-accent/40 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring has-[a:focus-visible]:ring-inset"
							>
								<AgentRunStatus status={run.status} />
								<div class="flex min-w-0 flex-1 flex-col gap-0.5">
									<a
										href={resolve(`/agents/${data.agent.id}/runs/${run.id}`)}
										class="text-sm font-medium outline-none after:absolute after:inset-0 after:content-['']"
										title={formatTimeAgo(run.startedAt)}
									>
										{formatDateTime(run.startedAt, data.timeFormat)}
									</a>
									<p class="truncate text-xs text-muted-foreground">
										{RUN_TRIGGER_LABELS[run.trigger] ?? run.trigger}
										{#if took}· took {took}{:else if run.status === 'running'}· running{/if}
										{#if data.showUser}· by {data.users[run.userId] ?? run.userId}{/if}
									</p>
									{#if error}
										<p class="line-clamp-1 text-xs text-muted-foreground" title={error}>{error}</p>
									{/if}
								</div>
								{#if run.status === 'running'}
									<!-- Above the row link's click target. -->
									<Button
										variant="outline"
										size="sm"
										class="relative z-10"
										disabled={stopBusy === run.id}
										onclick={() => stopRun(run)}
									>
										{stopBusy === run.id ? 'Stopping…' : 'Stop'}
									</Button>
								{/if}
								<ChevronRightIcon
									class="size-4 shrink-0 text-muted-foreground"
									aria-hidden="true"
								/>
							</li>
						{/each}
					</ul>
				{/if}
			</SettingsSection>
		</div>
	</div>
</div>
