<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { formatDateTime, formatTimeAgo } from '$lib/datetime.js';
	import type { AgentRun } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let stopBusy = $state<string | null>(null);

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

	function statusVariant(run: AgentRun): 'outline' | 'secondary' | 'destructive' {
		if (run.status === 'running') return 'outline';
		if (run.status === 'success') return 'secondary';
		return 'destructive';
	}

	function statusClass(run: AgentRun): string {
		if (run.status === 'running') return 'border-info/50 text-info-foreground';
		if (run.status === 'success') return 'text-success-foreground';
		return '';
	}

	function duration(run: AgentRun): string {
		return run.endedAt ? `${((run.endedAt - run.startedAt) / 1000).toFixed(1)}s` : '—';
	}

	function truncate(text: string, max = 60): string {
		return text.length > max ? `${text.slice(0, max)}…` : text;
	}
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
		<div class="flex flex-col gap-1">
			<Breadcrumb.Root>
				<Breadcrumb.List>
					<Breadcrumb.Item>
						<Breadcrumb.Link href={resolve('/agents')}>Agents</Breadcrumb.Link>
					</Breadcrumb.Item>
					<Breadcrumb.Separator />
					<Breadcrumb.Item>
						<Breadcrumb.Page>{data.agent.name}</Breadcrumb.Page>
					</Breadcrumb.Item>
				</Breadcrumb.List>
			</Breadcrumb.Root>
			<h1 class="text-xl font-semibold">Runs</h1>
		</div>

		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>Status</Table.Head>
					<Table.Head>Trigger</Table.Head>
					{#if data.showUser}
						<Table.Head>User</Table.Head>
					{/if}
					<Table.Head>Started</Table.Head>
					<Table.Head>Duration</Table.Head>
					<Table.Head>Error</Table.Head>
					<Table.Head class="text-right">Actions</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.runs as run (run.id)}
					<Table.Row
						class="cursor-pointer"
						onclick={() => goto(resolve(`/agents/${data.agent.id}/runs/${run.id}`))}
					>
						<Table.Cell>
							<Badge variant={statusVariant(run)} class={statusClass(run)}>
								{#if run.status === 'running'}
									<LoaderCircleIcon class="size-3.5 animate-spin" />
								{/if}
								{run.status}
							</Badge>
						</Table.Cell>
						<Table.Cell>
							<Badge variant="secondary">{run.trigger}</Badge>
						</Table.Cell>
						{#if data.showUser}
							<Table.Cell class="whitespace-nowrap text-muted-foreground">
								{data.users[run.userId] ?? run.userId}
							</Table.Cell>
						{/if}
						<Table.Cell class="whitespace-nowrap text-muted-foreground">
							<span title={formatDateTime(run.startedAt, data.timeFormat)}>
								{formatTimeAgo(run.startedAt)}
							</span>
						</Table.Cell>
						<Table.Cell class="text-muted-foreground">{duration(run)}</Table.Cell>
						<Table.Cell class="max-w-64 truncate text-muted-foreground" title={run.error ?? ''}>
							{run.error ? truncate(run.error) : '—'}
						</Table.Cell>
						<Table.Cell class="text-right">
							{#if run.status === 'running'}
								<Button
									variant="destructive"
									size="sm"
									disabled={stopBusy === run.id}
									onclick={(e) => {
										e.stopPropagation();
										stopRun(run);
									}}
								>
									{stopBusy === run.id ? 'Stopping…' : 'Stop'}
								</Button>
							{/if}
						</Table.Cell>
					</Table.Row>
				{:else}
					<Table.Row>
						<Table.Cell colspan={data.showUser ? 7 : 6} class="text-center text-muted-foreground">
							No runs yet.
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
</div>
