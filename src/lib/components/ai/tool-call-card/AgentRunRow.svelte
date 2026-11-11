<script lang="ts" module>
	/** Agent names by id, shared by every row so a chat looks each agent up once. */
	// A plain cache of promises: nothing renders from the map itself.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const nameCache = new Map<string, Promise<string | null>>();

	function lookUpName(id: string): Promise<string | null> {
		let pending = nameCache.get(id);
		if (!pending) {
			pending = fetch(`/api/agents/${encodeURIComponent(id)}`)
				.then((r) => (r.ok ? r.json() : null))
				.then((b: { agent?: { name?: string } } | null) => b?.agent?.name ?? null)
				.catch(() => null);
			nameCache.set(id, pending);
		}
		return pending;
	}
</script>

<script lang="ts">
	import { resolve } from '$app/paths';
	import { untrack } from 'svelte';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleSlashIcon from '@lucide/svelte/icons/circle-slash';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import MessageCircleQuestionIcon from '@lucide/svelte/icons/message-circle-question';
	import RadioIcon from '@lucide/svelte/icons/radio';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { Markdown } from '$lib/components/ai/markdown/index.js';
	import { agentDisplayName, formatRunError } from '$lib/agent-labels.js';
	import {
		AGENT_RUN_PHASE_LABEL,
		AGENT_RUN_PHASE_SHORT_LABEL,
		agentRunPhase,
		isRunOpen,
		latestRunReply,
		parseAgentRunOutput,
		replyPreview,
		describeRefusal,
		type AgentRunPhase
	} from '$lib/agent-run-tool.js';
	import { formatElapsed } from '$lib/formats.js';
	import { now } from '$lib/state/now.svelte.js';
	import { onServerEvent, onServerEventResync } from '$lib/state/events.svelte.js';
	import { toolFailed } from '$lib/tool-meta.js';
	import type { AgentRun } from '$lib/types.js';
	import { cn } from '$lib/utils.js';

	/**
	 * A `start_agent` / `get_agent_run` call: the run it started or waited on,
	 * kept live while it works or waits on the user, with the agent's reply one
	 * click away. Same shape as a subagent row in the activity timeline.
	 */
	type ToolPart = {
		toolCallId: string;
		state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
		input?: unknown;
		output?: unknown;
		errorText?: string;
	};

	let { part, name, active = true }: { part: ToolPart; name: string; active?: boolean } = $props();

	let open = $state(false);
	const bodyId = $props.id();

	const args = $derived(
		(part.input && typeof part.input === 'object' ? part.input : {}) as {
			agentId?: unknown;
			runId?: unknown;
			instructions?: unknown;
		}
	);
	const incomplete = $derived(part.state === 'input-streaming' || part.state === 'input-available');
	const callRunning = $derived(incomplete && active);
	const parsed = $derived(
		part.state === 'output-available' ? parseAgentRunOutput(part.output) : null
	);
	/** The tool turned the call down (unknown agent, already running…): there is no new run. */
	const refusal = $derived.by(() => {
		if (part.state === 'output-error') return describeRefusal(part.errorText ?? '');
		if (!toolFailed(part)) return null;
		const content = (part.output as { content?: { text?: unknown }[] }).content;
		return describeRefusal(typeof content?.[0]?.text === 'string' ? content[0].text : '');
	});

	/**
	 * The run as the run API last reported it. `found` snapshots come from looking
	 * the run up while the call was at work, so the call's own result supersedes
	 * them; `fetched` ones were loaded to follow the run and are the newest state.
	 */
	let live = $state<{
		run: AgentRun;
		reply: string | null;
		question: string | null;
		source: 'found' | 'fetched';
	} | null>(null);
	let lookedUpName = $state<string | null>(null);
	/** Only trusted for the run the tool reported, and never over its result with a stale lookup. */
	const current = $derived(
		live && (!parsed || (live.run.id === parsed.run.id && live.source === 'fetched')) ? live : null
	);

	const run = $derived(current?.run ?? parsed?.run ?? null);
	const agentId = $derived(
		parsed?.agent.id ?? run?.agentId ?? (typeof args.agentId === 'string' ? args.agentId : null)
	);
	const agentName = $derived(parsed?.agent.name ?? lookedUpName);
	const reply = $derived(current ? current.reply : (parsed?.result ?? null));
	const question = $derived(
		run?.status === 'awaiting_input'
			? current
				? current.question
				: (parsed?.question ?? null)
			: null
	);
	const runPath = $derived.by(() => {
		const runId = run?.id ?? refusal?.runId;
		return agentId && runId
			? resolve('/(app)/agents/[id]/runs/[runId]', { id: agentId, runId })
			: null;
	});
	/** The run's chat, where the user answers it (only runs that ask have one to open). */
	const chatPath = $derived(
		(parsed?.chatPath || question) && run?.conversationId
			? resolve('/(app)/chat/[id]', { id: run.conversationId })
			: null
	);
	const instructions = $derived(
		typeof args.instructions === 'string' && args.instructions.trim()
			? args.instructions.trim()
			: null
	);

	/** Whether the run an "already running" refusal points at still is: null until checked. */
	let busyStillOpen = $state<boolean | null>(null);
	/** When that earlier run started, so the busy row shows how long it has been at work. */
	let busyStartedAt = $state<number | null>(null);

	const phase = $derived.by((): AgentRunPhase => {
		// Already running isn't a failure: the agent is at work, just on an earlier call.
		if (refusal?.runId) return busyStillOpen === false ? 'wasBusy' : 'busy';
		if (refusal) return 'refused';
		// The chat's turn was stopped before the call learned its run.
		if (incomplete && !active && !run) return 'stopped';
		return agentRunPhase(run, { callRunning });
	});
	const working = $derived(
		phase === 'starting' || phase === 'running' || phase === 'background' || phase === 'busy'
	);
	const failed = $derived(phase === 'failed' || phase === 'refused');

	const title = $derived(
		agentName ? agentDisplayName(agentName) : phase === 'refused' ? 'Unknown agent' : 'Agent'
	);
	const errorText = $derived(
		phase === 'refused'
			? (refusal?.reason ?? null)
			: failed
				? (formatRunError(run?.error ?? null) ?? null)
				: null
	);
	const activity = $derived.by((): string => {
		switch (phase) {
			case 'starting':
				return 'Starting the run…';
			case 'running':
				return 'Working on it…';
			case 'background':
				return 'Working in the background';
			case 'busy':
				return "Busy with an earlier run; this one didn't start";
			case 'wasBusy':
				return 'The agent was busy with another run';
			case 'done':
				return replyPreview(reply) ?? 'Finished without a reply';
			case 'asking':
				return question ?? 'Waiting for your answer';
			case 'failed':
			case 'refused':
				return errorText?.split('\n')[0] ?? 'The run failed';
			case 'stopped':
				return run ? 'Stopped before it finished' : 'Stopped before the run started';
			case 'dismissed':
				return formatRunError(run?.error ?? null) ?? 'Dismissed before it finished';
		}
	});
	const duration = $derived.by(() => {
		if (phase === 'busy' && busyStartedAt) return formatElapsed(now() - busyStartedAt);
		if (!run) return null;
		if (run.status === 'running') return formatElapsed(now() - run.startedAt);
		return run.endedAt ? formatElapsed(run.endedAt - run.startedAt) : null;
	});

	// What the open row shows. The activity line steps aside when the body says it in full.
	const showReply = $derived(!!reply && phase === 'done');
	const showQuestion = $derived(phase === 'asking' && !!question);
	const showError = $derived(failed && !!errorText);
	const hideActivity = $derived(
		open && (showQuestion || showError || showReply || (working && !!instructions))
	);
	/** A reply that opens with its own heading needs no "Result" label above it. */
	const replyHasHeading = $derived(!!reply && reply.trimStart().startsWith('#'));
	const hasBody = $derived(
		!!instructions || showReply || showQuestion || showError || (!!runPath && !working)
	);
	/** The one thing to do from the collapsed row: answer the agent, or watch it work. */
	const action = $derived(
		phase === 'asking' && chatPath
			? { href: chatPath, label: 'Answer', short: 'Answer', primary: true }
			: working && runPath
				? { href: runPath, label: 'Watch live', short: 'Watch', primary: false }
				: null
	);

	/** Announce how a run ended only to someone who saw it working, not for rows loaded finished. */
	let seenWorking = $state(false);
	$effect(() => {
		if (working) seenWorking = true;
	});

	// ── live updates ─────────────────────────────────────────────────────────

	$effect(() => {
		const id = agentId;
		if (!id || parsed?.agent.name) return;
		let cancelled = false;
		lookUpName(id).then((n) => {
			if (!cancelled) lookedUpName = n;
		});
		return () => {
			cancelled = true;
		};
	});

	/** Only the newest refresh may land: an older response must not overwrite a newer one. */
	let refreshSeq = 0;

	async function refreshRun(id: string) {
		const seq = ++refreshSeq;
		const res = await fetch(`/api/agent-runs/${encodeURIComponent(id)}`).catch(() => null);
		if (!res?.ok || seq !== refreshSeq) return;
		const body = (await res.json().catch(() => null)) as {
			run: AgentRun;
			messages: { role: string; parts: unknown[] }[];
		} | null;
		if (!body || seq !== refreshSeq) return;
		const latest =
			body.run.status === 'running'
				? { text: null, question: null }
				: latestRunReply(body.messages);
		live = { run: body.run, reply: latest.text, question: latest.question, source: 'fetched' };
	}

	// Check (and keep checking) whether the run an "already running" refusal points at is still busy.
	$effect(() => {
		const id = refusal?.runId;
		if (!id) return;
		let cancelled = false;
		const check = async () => {
			const res = await fetch(`/api/agent-runs/${encodeURIComponent(id)}`).catch(() => null);
			const body = res?.ok
				? ((await res.json().catch(() => null)) as { run?: AgentRun } | null)
				: null;
			// A run that is gone (deleted, or not this user's) has nothing left to watch.
			if (cancelled) return;
			busyStillOpen = body?.run ? isRunOpen(body.run.status) : false;
			busyStartedAt = body?.run?.startedAt ?? null;
		};
		untrack(check);
		const offEvent = onServerEvent((event) => {
			if (event.type === 'agent.run.finished' && event.runId === id) check();
		});
		return () => {
			cancelled = true;
			offEvent();
		};
	});

	/** Until start_agent returns, its run is the agent's newest running manual run. */
	async function findStartedRun(id: string) {
		const res = await fetch(`/api/agents/${encodeURIComponent(id)}/runs?limit=5`).catch(() => null);
		if (!res?.ok) return;
		const body = (await res.json().catch(() => null)) as { runs?: AgentRun[] } | null;
		const started = body?.runs?.find((r) => r.status === 'running' && r.trigger === 'manual');
		if (started && !live && !parsed) {
			live = { run: started, reply: null, question: null, source: 'found' };
		}
	}

	// Find the run while the call is still at work (also after a reload mid-run).
	$effect(() => {
		if (!callRunning || live) return;
		const id = agentId;
		if (name === 'get_agent_run' && typeof args.runId === 'string') {
			const runId = args.runId;
			untrack(() => refreshRun(runId));
			return;
		}
		if (!id) return;
		untrack(() => findStartedRun(id));
		return onServerEvent((event) => {
			if (event.type === 'agent.run.started' && event.agentId === id) findStartedRun(id);
		});
	});

	// Follow a run that can still change: working, or waiting on the user's answer.
	$effect(() => {
		if (!run || !isRunOpen(run.status)) return;
		const id = run.id;
		// It may have moved on while this chat was closed.
		if (!callRunning && !current) untrack(() => refreshRun(id));
		const offEvent = onServerEvent((event) => {
			if (
				(event.type === 'agent.run.finished' ||
					event.type === 'agent.run.started' ||
					event.type === 'agent.run.awaiting_input') &&
				event.runId === id
			) {
				refreshRun(id);
			}
		});
		const offResync = onServerEventResync(() => refreshRun(id));
		return () => {
			offEvent();
			offResync();
		};
	});

	/** Fades the clipped edge of a long result so the cut reads as scrollable. */
	function fadeWhenClipped(node: HTMLElement) {
		const update = () => {
			const below = node.scrollHeight - node.scrollTop - node.clientHeight > 4;
			node.toggleAttribute('data-clipped', below);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(node);
		if (node.firstElementChild) observer.observe(node.firstElementChild);
		node.addEventListener('scroll', update, { passive: true });
		return () => {
			observer.disconnect();
			node.removeEventListener('scroll', update);
		};
	}

	const linkClass =
		'inline-flex items-center gap-1 rounded underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none';
</script>

{#snippet rowContent()}
	<span class="flex size-5 shrink-0 items-center justify-center">
		{#if working}
			<Loader2Icon class="size-4 animate-spin text-info motion-reduce:animate-none" />
		{:else if phase === 'done'}
			<CircleCheckIcon class="size-4 text-success" />
		{:else if phase === 'asking'}
			<MessageCircleQuestionIcon class="size-4 text-warning" />
		{:else if failed}
			<TriangleAlertIcon class="size-4 text-destructive" />
		{:else}
			<CircleSlashIcon class="size-4 text-muted-foreground" />
		{/if}
	</span>
	<span class="flex min-w-0 flex-1 flex-col">
		<span class="truncate font-medium text-foreground/90" title={agentName ?? undefined}>
			{title}
		</span>
		{#if !hideActivity}
			<span
				class={cn(
					'text-xs text-muted-foreground',
					// What needs reading (a question, why it failed) gets two lines.
					phase === 'asking' || phase === 'busy' || failed
						? 'line-clamp-2 break-words'
						: 'truncate',
					phase === 'failed' && 'text-destructive/80',
					phase === 'asking' && 'text-foreground/80'
				)}
				title={activity}>{activity}</span
			>
		{/if}
	</span>
	<span
		class={cn(
			'flex h-5 shrink-0 items-center gap-1.5 pl-2 text-xs whitespace-nowrap',
			working && 'text-info-foreground',
			phase === 'done' && 'text-success-foreground',
			phase === 'asking' && 'text-warning-foreground',
			failed && 'text-destructive',
			(phase === 'stopped' || phase === 'dismissed' || phase === 'wasBusy') &&
				'text-muted-foreground'
		)}
	>
		{#if AGENT_RUN_PHASE_SHORT_LABEL[phase]}
			<span class="sm:hidden">{AGENT_RUN_PHASE_SHORT_LABEL[phase]}</span>
			<span class="max-sm:hidden">{AGENT_RUN_PHASE_LABEL[phase]}</span>
		{:else}
			{AGENT_RUN_PHASE_LABEL[phase]}
		{/if}
		{#if duration}
			<span
				class={cn('text-muted-foreground tabular-nums', working && 'max-sm:hidden')}
				title={working ? `Running for ${duration}` : `Took ${duration}`}>· {duration}</span
			>
		{/if}
		<ChevronRightIcon
			aria-hidden="true"
			class={cn(
				'size-3.5 text-muted-foreground transition motion-reduce:transition-none',
				hasBody
					? 'opacity-50 group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100'
					: 'invisible',
				open && 'rotate-90 opacity-100'
			)}
		/>
	</span>
{/snippet}

<div class="flex w-full min-w-0 flex-col text-sm">
	<div class="flex w-full min-w-0 items-start gap-1">
		<!-- A row with nothing to open is plain text, not a disabled button. -->
		{#if hasBody}
			<button
				type="button"
				class="group/tool flex min-w-0 flex-1 items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
				aria-expanded={open}
				aria-controls={bodyId}
				onclick={() => (open = !open)}
			>
				{@render rowContent()}
			</button>
		{:else}
			<div
				class="group/tool flex min-w-0 flex-1 items-start gap-2.5 rounded-md px-2 py-1.5 text-left"
			>
				{@render rowContent()}
			</div>
		{/if}
		{#if action}
			<a
				href={action.href}
				class={cn(
					'mt-1 inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none max-sm:mt-0 max-sm:h-9 max-sm:px-3 sm:min-w-24',
					action.primary
						? 'bg-primary text-primary-foreground hover:bg-primary/90'
						: 'text-muted-foreground ring-1 ring-border ring-inset hover:bg-accent hover:text-foreground'
				)}
				aria-label={`${action.label}: ${title}`}
			>
				{#if !action.primary}
					<RadioIcon class="size-3.5" aria-hidden="true" />
				{/if}
				<span class="sm:hidden">{action.short}</span>
				<span class="max-sm:hidden">{action.label}</span>
			</a>
		{:else}
			<!-- Keeps the status in one column whether or not a row has an action. While
			     starting it holds Watch's place on mobile too, so the status doesn't jump. -->
			<span
				aria-hidden="true"
				class={cn('w-24 shrink-0', phase === 'starting' ? 'max-sm:w-[5.5rem]' : 'max-sm:hidden')}
			></span>
		{/if}
	</div>
	<span class="sr-only" aria-live="polite">
		{seenWorking && !working ? `${title}: ${AGENT_RUN_PHASE_LABEL[phase]}` : ''}
	</span>

	{#if open && hasBody}
		<div id={bodyId} class="mt-1 mb-2 ml-7 flex flex-col gap-2.5 sm:ml-9">
			{#if instructions}
				<div>
					<p class="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
						Task
					</p>
					<p class="text-sm whitespace-pre-wrap text-foreground/80">{instructions}</p>
				</div>
			{/if}
			{#if showQuestion}
				<div
					class="flex flex-col gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-3 py-2"
				>
					<p class="text-[11px] font-medium tracking-wide text-warning-foreground uppercase">
						Question for you
					</p>
					{#if reply && reply.trim() !== question?.trim()}
						<p class="text-xs text-muted-foreground">{reply}</p>
					{/if}
					<p class="text-sm font-medium">{question}</p>
				</div>
			{/if}
			{#if showReply}
				<div>
					{#if !replyHasHeading}
						<p class="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
							Result
						</p>
					{/if}
					<div class="relative">
						<!-- Focusable so a long result can be scrolled from the keyboard. -->
						<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
						<div
							{@attach fadeWhenClipped}
							class="peer max-h-80 overflow-auto focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset"
							role="region"
							aria-label={`${title} result`}
							tabindex="0"
						>
							<Markdown
								class="w-full max-w-none text-sm [&_h1]:mt-1 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:mt-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm"
								content={reply ?? ''}
							/>
						</div>
						<!-- An overlay, not a mask, and a square scroller: the table toolbar's backdrop blur renders as a solid block in Chromium inside a masked or rounded overflow clip. -->
						<div
							aria-hidden="true"
							class="pointer-events-none absolute inset-x-0 bottom-0 hidden h-12 bg-linear-to-t from-background to-transparent peer-data-clipped:block"
						></div>
					</div>
					{#if parsed?.truncated && !current}
						<p class="mt-1 text-xs text-muted-foreground">Shortened here; the run has all of it.</p>
					{/if}
				</div>
			{/if}
			{#if showError}
				<p
					class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs whitespace-pre-wrap text-destructive"
				>
					{errorText}
				</p>
			{/if}
			{#if runPath && !working}
				<a
					href={runPath}
					class={cn(
						linkClass,
						'self-start text-xs font-medium text-foreground/70 hover:text-foreground'
					)}
				>
					View run
					<ArrowUpRightIcon class="size-3" aria-hidden="true" />
				</a>
			{/if}
		</div>
	{/if}
</div>
