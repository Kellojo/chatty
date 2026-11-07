<script lang="ts">
	import { tick } from 'svelte';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import { mergeTranscript, transcriptCursor } from '$lib/agent-run-transcript.js';
	import { coalesce } from '$lib/coalesce.js';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import CodeXmlIcon from '@lucide/svelte/icons/code-xml';
	import SquareIcon from '@lucide/svelte/icons/square';
	import AgentRunStatus from '$lib/components/app/AgentRunStatus.svelte';
	import LiveElapsed from '$lib/components/app/LiveElapsed.svelte';
	import MessageTimeline from '$lib/components/app/MessageTimeline.svelte';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ThinkingIndicator from '$lib/components/app/ThinkingIndicator.svelte';
	import { formatRunDuration, formatRunError, RUN_TRIGGER_LABELS } from '$lib/agent-labels.js';
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

	const duration = $derived(formatRunDuration(run));

	// Like a chat: "Thinking…" until the agent produces visible output.
	const lastMessage = $derived(uiMessages.at(-1));
	const waiting = $derived(
		run.status === 'running' &&
			(!lastMessage ||
				lastMessage.role !== 'assistant' ||
				lastMessage.parts.every((p) =>
					p.type === 'text' || p.type === 'reasoning' ? p.text === '' : p.type === 'step-start'
				))
	);

	// Fetches only the transcript tail that can still change (see
	// transcriptCursor); events arriving mid-fetch fold into one follow-up fetch.
	const refresh = coalesce(async () => {
		const from = transcriptCursor(messages);
		const query = from ? `?${new URLSearchParams({ from })}` : '';
		const res = await fetch(`/api/agent-runs/${run.id}${query}`);
		if (!res.ok) return;
		const body = (await res.json()) as {
			run: AgentRun;
			messages: ChatMessage[];
			from: string | null;
		};
		const nearBottom = container
			? container.scrollHeight - container.scrollTop - container.clientHeight < 120
			: false;
		run = body.run;
		messages = mergeTranscript(messages, body.from, body.messages);
		tick().then(() => {
			if (nearBottom && container) container.scrollTop = container.scrollHeight;
		});
	});

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
</script>

<svelte:head><title>Run · {data.agent.name} · Chatty</title></svelte:head>

<div
	class="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto"
	bind:this={container}
>
	<div class="mx-auto w-full max-w-6xl p-4 md:p-6">
		<div class="flex flex-col gap-4">
			<PageHeader
				title="{RUN_TRIGGER_LABELS[run.trigger] ?? run.trigger} run"
				back={{ href: resolve(`/agents/${data.agent.id}/runs`), label: data.agent.name }}
			>
				{#snippet badges()}
					<AgentRunStatus status={run.status} label />
				{/snippet}
				{#snippet description()}
					<span title={formatDateTime(run.startedAt, data.timeFormat)}
						>Started {formatDateTime(run.startedAt, data.timeFormat)}</span
					>{#if duration}
						{` · took ${duration}`}{:else if run.status === 'running'}
						· running for <LiveElapsed since={run.startedAt} />{/if}
				{/snippet}
				{#snippet actions()}
					{#if data.isCodingTask && run.conversationId}
						<Button variant="outline" href={resolve(`/chat/${run.conversationId}`)}>
							<CodeXmlIcon class="size-4" />Open coding task
						</Button>
					{/if}
					{#if run.status === 'running'}
						<Button variant="outline" disabled={stopBusy} onclick={stopRun}>
							<SquareIcon class="size-4" />
							{stopBusy ? 'Stopping…' : 'Stop'}
						</Button>
					{/if}
				{/snippet}
			</PageHeader>
			{#if data.isCodingTask && run.conversationId}
				<p class="text-sm text-muted-foreground">
					This run is a coding task. It finishes when the coding agent's turn ends; approvals and
					follow-ups happen in the task.
				</p>
			{/if}
			{#if run.error}
				<div
					class="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
				>
					<CircleXIcon class="mt-0.5 size-4 shrink-0" />
					<p class="min-w-0 wrap-break-word whitespace-pre-wrap">
						{formatRunError(run.error) ??
							'The run failed without an error message. The transcript may show what happened.'}
					</p>
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
			conversationId={run.conversationId}
			class="max-w-6xl px-4 md:px-6"
		/>
	{/if}
	{#if waiting}
		<ThinkingIndicator since={run.startedAt} class="mx-auto w-full max-w-6xl px-4 pb-6 md:px-6" />
	{:else if uiMessages.length === 0}
		<p class="mx-auto w-full max-w-6xl px-4 pb-6 text-sm text-muted-foreground md:px-6">
			No transcript recorded for this run.
		</p>
	{/if}
</div>
