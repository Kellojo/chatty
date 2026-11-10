<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import { mergeTranscript, transcriptCursor } from '$lib/agent-run-transcript.js';
	import { coalesce } from '$lib/coalesce.js';
	import { errorSummary } from '$lib/error-text.js';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import CodeXmlIcon from '@lucide/svelte/icons/code-xml';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import SquareIcon from '@lucide/svelte/icons/square';
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
	import {
		agentDisplayName,
		formatRunDuration,
		formatRunError,
		isStoppedRun,
		RUN_TRIGGER_LABELS
	} from '$lib/agent-labels.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatDateTime } from '$lib/datetime.js';
	import { onServerEvent, onServerEventResync } from '$lib/state/events.svelte.js';
	import { chatMessageToUIMessage } from '$lib/types.js';
	import type { AgentRun, ChatMessage } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let run = $state(data.run);
	let messages = $state(data.messages);
	let scroll = $state<ChatContainerContext>();
	let stopBusy = $state(false);
	let stopRequested = $state(false);

	const uiMessages = $derived(messages.map(chatMessageToUIMessage));
	const messageTimes = $derived(new Map(messages.map((m) => [m.id, m.createdAt])));

	const duration = $derived(formatRunDuration(run));
	const running = $derived(run.status === 'running');
	const runError = $derived(formatRunError(run.error));
	// The compact link shows the gist; the transcript has the full text.
	const runErrorShort = $derived(runError ? errorSummary(runError) : null);
	// A failed final reply already shows the error where it happened; don't repeat it up top.
	const transcriptShowsError = $derived(messages.at(-1)?.status === 'failed');
	let scrollEl = $state<HTMLDivElement | null>(null);
	// How far the end of the transcript is below the fold. The scroller's own `isAtBottom`
	// only means "following", and a finished run starts unfollowed at the top.
	let endOutOfView = $state(false);
	$effect(() => {
		const el = scrollEl;
		const content = el?.firstElementChild;
		if (!el || !content) return;
		// At most one layout read per frame, however fast scroll and resize events arrive.
		let frame = 0;
		const measure = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				endOutOfView = el.scrollHeight - el.scrollTop - el.clientHeight > 48;
			});
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		observer.observe(content);
		el.addEventListener('scroll', measure, { passive: true });
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			el.removeEventListener('scroll', measure);
		};
	});

	/** Both jump controls vanish once the end is in view, so keyboard focus moves to the
	 *  transcript instead of falling back to the page. */
	function jumpToEnd() {
		scroll?.scrollToBottom();
		scrollEl?.focus({ preventScroll: true });
	}
	// A finished run's error link at the top does the jump-to-latest button's job.
	const showErrorLink = $derived(
		!running && !!run.error && !isStoppedRun(run) && transcriptShowsError && endOutOfView
	);
	const showJumpToLatest = $derived(
		running ? scroll !== undefined && !scroll.isAtBottom : endOutOfView
	);

	// The log is aria-busy while the run streams, so screen readers don't read every
	// step; announce once when it ends instead.
	let endAnnouncement = $state('');
	let wasRunning = untrack(() => run.status === 'running');
	$effect(() => {
		const now = running;
		if (wasRunning && !now) {
			endAnnouncement =
				run.status === 'success'
					? 'Run finished'
					: isStoppedRun(run)
						? 'Run stopped'
						: 'Run failed';
		}
		wasRunning = now;
	});
	// Live runs open at the newest output and follow it; finished ones open at the top.
	const initialScroll = untrack(() => run.status === 'running') ? 'instant' : false;
	// Otherwise the scroller starts out "following" and chases the content down as it lays out.
	$effect(() => {
		const ctx = scroll;
		if (initialScroll === false && ctx) untrack(() => ctx.stopScroll());
	});

	// Like a chat: "Thinking…" until the agent produces visible output.
	const lastMessage = $derived(uiMessages.at(-1));
	// The header already counts the whole run; the indicator counts since the last output.
	const waitingSince = $derived(messages.at(-1)?.createdAt ?? run.startedAt);
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
		run = body.run;
		messages = mergeTranscript(messages, body.from, body.messages);
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
		if (stopBusy || stopRequested) return;
		stopBusy = true;
		try {
			const res = await fetch(`/api/agent-runs/${run.id}/stop`, { method: 'POST' });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				toast.error(body?.message ?? 'Failed to stop run');
				return;
			}
			// The run winds down asynchronously: keep "Stopping…" until it reports finished.
			stopRequested = true;
			await refresh();
		} finally {
			stopBusy = false;
		}
	}
</script>

<svelte:head><title>Run · {agentDisplayName(data.agent.name)} · Chatty</title></svelte:head>

<div class="relative flex min-h-0 flex-1 flex-col">
	<!-- Compact on phones: it stays on screen the whole time. -->
	<div class="mx-auto w-full max-w-4xl shrink-0 px-4 pt-3 sm:pt-4 md:px-6 md:pt-6">
		<div class="flex flex-col gap-2 sm:gap-4">
			<PageHeader
				title="{RUN_TRIGGER_LABELS[run.trigger] ?? run.trigger} run"
				back={{
					href: resolve(`/agents/${data.agent.id}/runs`),
					label: agentDisplayName(data.agent.name)
				}}
			>
				{#snippet badges()}
					<AgentRunStatus status={run.status} stopped={isStoppedRun(run)} label />
				{/snippet}
				{#snippet description()}
					<span>Started {formatDateTime(run.startedAt, data.timeFormat)}</span>{#if duration}
						{` · took ${duration}`}{:else if running}
						· running for <LiveElapsed since={run.startedAt} />{/if}
				{/snippet}
				{#snippet actions()}
					{#if data.isCodingTask && run.conversationId}
						<Button
							variant="outline"
							class="max-sm:h-8 max-sm:px-3"
							href={resolve(`/chat/${run.conversationId}`)}
						>
							<CodeXmlIcon class="size-4" />Open coding task
						</Button>
					{/if}
					{#if running}
						{@const stopping = stopBusy || stopRequested}
						<!-- aria-disabled, not disabled: keyboard focus stays on the button while it stops. -->
						<Button
							variant="outline"
							aria-disabled={stopping}
							class="text-destructive hover:text-destructive aria-disabled:pointer-events-none aria-disabled:opacity-60 max-sm:h-8 max-sm:px-3"
							onclick={stopRun}
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
			{#if run.error && isStoppedRun(run)}
				<p class="text-sm text-muted-foreground">You stopped this run.</p>
			{:else if run.error && transcriptShowsError}
				<!-- The full error sits at the end of the transcript; point to it while it's out of view. -->
				{#if showErrorLink}
					<button
						type="button"
						class="flex w-fit max-w-full items-start gap-2 rounded-md text-left text-sm text-destructive underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:opacity-70"
						aria-label="Jump to the error: {runErrorShort ?? 'The run failed.'}"
						onclick={jumpToEnd}
					>
						<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />
						<span class="line-clamp-1 min-w-0 sm:line-clamp-2"
							>{runErrorShort ?? 'The run failed.'}</span
						>
						<ArrowDownIcon class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
					</button>
				{/if}
			{:else if run.error}
				<div
					class="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
				>
					<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />
					<p class="min-w-0 wrap-break-word whitespace-pre-wrap">
						{runError ??
							'The run failed without an error message. The transcript may show what happened.'}
					</p>
				</div>
			{/if}
		</div>
	</div>

	<!-- The header (status, Stop) stays put; only the transcript scrolls. It sticks to the newest
	     output while that's in view, like a chat; scrolling up stops following. -->
	<ChatContainer
		bind:context={scroll}
		bind:ref={scrollEl}
		initial={initialScroll}
		aria-busy={running}
		aria-label="Run transcript"
		tabindex={0}
		class="min-h-0 flex-1 [scrollbar-gutter:stable_both-edges] [mask-image:linear-gradient(to_bottom,transparent,black_1rem,black_calc(100%-2rem),transparent)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset max-sm:[mask-image:linear-gradient(to_bottom,transparent,black_1rem,black_calc(100%-2rem),transparent)]"
	>
		<ChatContainerContent>
			{#if data.isCodingTask && run.conversationId}
				<!-- Scrolls away with the transcript so the fixed header stays short on phones. -->
				<p class="mx-auto w-full max-w-4xl px-4 pt-4 text-sm text-muted-foreground md:px-6">
					This run is a coding task. It finishes when the coding agent's turn ends; approvals and
					follow-ups happen in the task.
				</p>
			{/if}
			{#if uiMessages.length > 0}
				<h2 class="sr-only">Transcript</h2>
				<MessageTimeline
					messages={uiMessages}
					streaming={running}
					timeFormat={data.timeFormat}
					{messageTimes}
					conversationId={run.conversationId}
					class="max-w-4xl px-4 pt-4 md:px-6"
				/>
			{/if}
			{#if waiting}
				<ThinkingIndicator
					since={waitingSince}
					class="mx-auto w-full max-w-4xl px-4 pt-2 md:px-6"
				/>
			{:else if uiMessages.length === 0}
				<p class="mx-auto w-full max-w-4xl px-4 text-sm text-muted-foreground md:px-6">
					No transcript recorded for this run.
				</p>
			{/if}
			<!-- Keeps the newest line clear of the bottom fade (and the iOS home indicator). -->
			<div class="h-[calc(2.5rem+env(safe-area-inset-bottom))] shrink-0" aria-hidden="true"></div>
		</ChatContainerContent>
	</ChatContainer>
	<div role="status" class="sr-only">{endAnnouncement}</div>

	{#if showJumpToLatest && !showErrorLink}
		<Button
			variant="outline"
			size="icon"
			class="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-10 -translate-x-1/2 rounded-full bg-background shadow-md hover:bg-muted dark:bg-background dark:hover:bg-muted"
			onclick={jumpToEnd}
		>
			<ArrowDownIcon class="size-4" />
			{#if running}
				<span
					class="absolute top-0 right-0 size-2.5 rounded-full border-2 border-background bg-info"
					aria-hidden="true"
				></span>
			{/if}
			<span class="sr-only">
				{running ? 'Jump to latest, new content is arriving' : 'Jump to latest'}
			</span>
		</Button>
	{/if}
</div>
