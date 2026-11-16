<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import SquareIcon from '@lucide/svelte/icons/square';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import {
		ChatContainer,
		ChatContainerContent,
		type ChatContainerContext
	} from '$lib/components/ai/chat-container/index.js';
	import AgentRunStatus from '$lib/components/app/AgentRunStatus.svelte';
	import LiveElapsed from '$lib/components/app/LiveElapsed.svelte';
	import MessageTimeline from '$lib/components/app/MessageTimeline.svelte';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ThinkingIndicator from '$lib/components/app/ThinkingIndicator.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatDateTime } from '$lib/datetime.js';
	import { formatElapsed } from '$lib/formats.js';
	import { readableErrorText } from '$lib/error-text.js';
	import type { SubagentInfo } from '$lib/subagent-tool.js';
	import { chatMessageToUIMessage, type ChatMessage } from '$lib/types.js';
	import type { PageData } from './$types';

	/**
	 * A subagent's transcript: what it was asked, every step it took and its
	 * report. Read-only; it follows the subagent live while it works.
	 */
	let { data }: { data: PageData } = $props();

	let subagent = $state(untrack(() => data.subagent));
	let messages = $state(untrack(() => data.messages));
	let scroll = $state<ChatContainerContext>();
	let stopping = $state(false);

	const running = $derived(subagent.status === 'running');
	const uiMessages = $derived(messages.map(chatMessageToUIMessage));
	const messageTimes = $derived(new Map(messages.map((m) => [m.id, m.createdAt])));
	const duration = $derived(
		subagent.endedAt ? formatElapsed(subagent.endedAt - subagent.startedAt) : null
	);
	const backHref = $derived(
		subagent.parentIsChat ? resolve('/(app)/chat/[id]', { id: subagent.parentId }) : null
	);

	// Live subagents open at the newest output and follow it; finished ones open at the top.
	const initialScroll = untrack(() => subagent.status === 'running') ? 'instant' : false;
	$effect(() => {
		const ctx = scroll;
		if (initialScroll === false && ctx) untrack(() => ctx.stopScroll());
	});

	// Like a chat: "Thinking…" until the subagent produces visible output.
	const waiting = $derived.by(() => {
		if (!running) return false;
		const last = uiMessages.at(-1);
		return (
			!last ||
			last.role !== 'assistant' ||
			last.parts.every((p) =>
				p.type === 'text' || p.type === 'reasoning' ? p.text === '' : p.type === 'step-start'
			)
		);
	});
	const waitingSince = $derived(messages.at(-1)?.createdAt ?? subagent.startedAt);

	async function refresh(id: string) {
		const res = await fetch(`/api/subagents/${encodeURIComponent(id)}`).catch(() => null);
		if (!res?.ok) return;
		const body = (await res.json()) as { subagent: SubagentInfo; messages: ChatMessage[] };
		if (body.subagent.id !== subagent.id) return;
		subagent = body.subagent;
		messages = body.messages;
	}

	// Hidden conversations publish no chat events: follow a working subagent by polling.
	$effect(() => {
		if (!running) return;
		const id = subagent.id;
		const timer = setInterval(() => void refresh(id), 1500);
		return () => clearInterval(timer);
	});

	async function stop() {
		if (stopping) return;
		stopping = true;
		try {
			const res = await fetch(`/api/subagents/${encodeURIComponent(subagent.id)}/stop`, {
				method: 'POST'
			});
			if (!res.ok) toast.error('Could not stop the subagent');
			await refresh(subagent.id);
		} finally {
			stopping = false;
		}
	}

	const statusForBadge = $derived(
		subagent.status === 'completed'
			? 'success'
			: subagent.status === 'running'
				? 'running'
				: 'failed'
	);
</script>

<svelte:head><title>Subagent · {subagent.description} · Chatty</title></svelte:head>

<div class="relative flex min-h-0 flex-1 flex-col">
	<div class="mx-auto w-full max-w-4xl shrink-0 px-4 pt-3 sm:pt-4 md:px-6 md:pt-6">
		<div class="flex flex-col gap-2 sm:gap-4">
			<PageHeader
				title={subagent.description}
				back={backHref ? { href: backHref, label: subagent.parentTitle } : undefined}
			>
				{#snippet badges()}
					<AgentRunStatus status={statusForBadge} stopped={subagent.status === 'stopped'} label />
				{/snippet}
				{#snippet description()}
					<span
						>{`Subagent · started ${formatDateTime(subagent.startedAt, data.timeFormat)}`}{duration
							? ` · took ${duration}`
							: running
								? ' · working for '
								: ''}{#if running && !duration}<LiveElapsed since={subagent.startedAt} />{/if}</span
					>
					<!-- What this page is: a record of work done elsewhere, not a chat to continue. -->
					<span class="mt-0.5 block text-xs"
						>Read-only. It worked in its own context and {running
							? 'reports back'
							: 'reported back'} to “{subagent.parentTitle}”.</span
					>
				{/snippet}
				{#snippet actions()}
					{#if running}
						<Button
							variant="outline"
							aria-disabled={stopping}
							class="text-destructive hover:text-destructive aria-disabled:pointer-events-none aria-disabled:opacity-60 max-sm:h-8 max-sm:px-3"
							onclick={stop}
						>
							{#if stopping}
								<LoaderCircleIcon class="size-4 animate-spin motion-reduce:animate-none" />
							{:else}
								<SquareIcon class="size-4 fill-destructive text-destructive" />
							{/if}
							{stopping ? 'Stopping…' : 'Stop'}
						</Button>
					{/if}
				{/snippet}
			</PageHeader>
			{#if subagent.status === 'failed' && subagent.error}
				<div
					class="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
					role="alert"
				>
					<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					<p class="min-w-0 wrap-break-word whitespace-pre-wrap">
						{readableErrorText(subagent.error)}
					</p>
				</div>
			{:else if subagent.status === 'stopped'}
				<p class="text-sm text-muted-foreground">Stopped before it finished.</p>
			{/if}
		</div>
	</div>

	<ChatContainer
		bind:context={scroll}
		initial={initialScroll}
		aria-busy={running}
		aria-label="Subagent transcript"
		tabindex={0}
		class="min-h-0 flex-1 [scrollbar-gutter:stable_both-edges] [mask-image:linear-gradient(to_bottom,transparent,black_1rem,black_calc(100%-2rem),transparent)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
	>
		<ChatContainerContent>
			{#if uiMessages.length > 0}
				<h2 class="sr-only">Transcript</h2>
				<MessageTimeline
					messages={uiMessages}
					streaming={running}
					timeFormat={data.timeFormat}
					{messageTimes}
					conversationId={subagent.id}
					class="max-w-4xl px-4 pt-4 md:px-6"
				/>
			{/if}
			<!-- Polled, not streamed: while it works there is always a next step coming. -->
			{#if waiting || running}
				<ThinkingIndicator
					since={waitingSince}
					class="mx-auto w-full max-w-4xl px-4 pt-2 md:px-6"
				/>
			{:else if uiMessages.length === 0}
				<p class="mx-auto w-full max-w-4xl px-4 text-sm text-muted-foreground md:px-6">
					No transcript recorded for this subagent.
				</p>
			{/if}
			<div class="h-[calc(2.5rem+env(safe-area-inset-bottom))] shrink-0" aria-hidden="true"></div>
		</ChatContainerContent>
	</ChatContainer>
</div>
