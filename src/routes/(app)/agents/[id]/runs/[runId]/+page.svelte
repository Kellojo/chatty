<script lang="ts">
	import { tick } from 'svelte';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import MessageTimeline from '$lib/components/app/MessageTimeline.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatDateTime } from '$lib/datetime.js';
	import { onServerEvent, onServerEventResync } from '$lib/state/events.svelte.js';
	import { chatMessageToUIMessage } from '$lib/types.js';
	import type { AgentRun, ChatMessage } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let run = $state(data.run);
	let messages = $state(data.messages);
	let container = $state<HTMLDivElement>();
	let stopBusy = $state(false);

	const uiMessages = $derived(messages.map(chatMessageToUIMessage));
	const messageTimes = $derived(new Map(messages.map((m) => [m.id, m.createdAt])));

	const duration = $derived(
		run.endedAt ? `${((run.endedAt - run.startedAt) / 1000).toFixed(1)}s` : '—'
	);

	let refreshing = false;
	let queued = false;

	async function refresh() {
		if (refreshing) {
			queued = true;
			return;
		}
		refreshing = true;
		try {
			const res = await fetch(`/api/agent-runs/${run.id}`);
			if (!res.ok) return;
			const body = (await res.json()) as { run: AgentRun; messages: ChatMessage[] };
			const nearBottom = container
				? container.scrollHeight - container.scrollTop - container.clientHeight < 120
				: false;
			run = body.run;
			messages = body.messages;
			tick().then(() => {
				if (nearBottom && container) container.scrollTop = container.scrollHeight;
			});
		} finally {
			refreshing = false;
			if (queued) {
				queued = false;
				await refresh();
			}
		}
	}

	$effect(() => {
		if (run.status !== 'running') return;
		const id = run.id;
		const offEvent = onServerEvent((event) => {
			if (
				(event.type === 'agent.run.progress' || event.type === 'agent.run.finished') &&
				event.runId === id
			) {
				refresh().catch(() => {});
			}
		});
		const offResync = onServerEventResync(() => {
			if (run.status === 'running') refresh().catch(() => {});
		});
		return () => {
			offEvent();
			offResync();
		};
	});

	async function stopRun() {
		stopBusy = true;
		try {
			const res = await fetch(`/api/agent-runs/${run.id}/stop`, { method: 'POST' });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				toast.error(body?.message ?? 'Failed to stop run');
				return;
			}
			toast.success('Stop requested');
			await refresh();
		} finally {
			stopBusy = false;
		}
	}

	function statusVariant(): 'outline' | 'secondary' | 'destructive' {
		if (run.status === 'running') return 'outline';
		if (run.status === 'success') return 'secondary';
		return 'destructive';
	}

	function statusClass(): string {
		if (run.status === 'running') return 'border-info/50 text-info-foreground';
		if (run.status === 'success') return 'text-success-foreground';
		return '';
	}
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto" bind:this={container}>
	<div class="border-b px-6 py-4">
		<div class="mx-auto flex w-full max-w-7xl flex-col gap-2">
			<Breadcrumb.Root>
				<Breadcrumb.List>
					<Breadcrumb.Item>
						<Breadcrumb.Link href={resolve('/agents')}>Agents</Breadcrumb.Link>
					</Breadcrumb.Item>
					<Breadcrumb.Separator />
					<Breadcrumb.Item>
						<Breadcrumb.Link href={resolve(`/agents/${data.agent.id}/runs`)}>
							{data.agent.name}
						</Breadcrumb.Link>
					</Breadcrumb.Item>
					<Breadcrumb.Separator />
					<Breadcrumb.Item>
						<Breadcrumb.Page>Run</Breadcrumb.Page>
					</Breadcrumb.Item>
				</Breadcrumb.List>
			</Breadcrumb.Root>
			<div class="flex flex-wrap items-center gap-2">
				<h1 class="text-xl font-semibold">{data.agent.name}</h1>
				<Badge variant={statusVariant()} class={statusClass()}>{run.status}</Badge>
				<Badge variant="secondary">{run.trigger}</Badge>
				{#if run.status === 'running'}
					<Button variant="destructive" size="sm" disabled={stopBusy} onclick={stopRun}>
						{stopBusy ? 'Stopping…' : 'Stop'}
					</Button>
				{/if}
			</div>
			<p class="text-sm text-muted-foreground">
				Started {formatDateTime(run.startedAt, data.timeFormat)} · Duration {duration}
			</p>
			{#if run.error}
				<div
					class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
				>
					{run.error}
				</div>
			{/if}
		</div>
	</div>

	{#if uiMessages.length > 0}
		<MessageTimeline
			messages={uiMessages}
			streaming={run.status === 'running'}
			timeFormat={data.timeFormat}
			{messageTimes}
			class="max-w-7xl px-6"
		/>
	{:else}
		<p class="mx-auto w-full max-w-7xl px-6 py-6 text-sm text-muted-foreground">
			No transcript recorded for this run.
		</p>
	{/if}
</div>
