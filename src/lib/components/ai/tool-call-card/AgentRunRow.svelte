<script lang="ts" module>
	import { isRunOpen, latestRunReply } from '$lib/agent-run-tool.js';
	import type { AgentRun } from '$lib/types.js';

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
				.catch(() => {
					// Offline or similar: let a later row try again.
					nameCache.delete(id);
					return null;
				});
			nameCache.set(id, pending);
		}
		return pending;
	}

	type RunState = { run: AgentRun; reply: string | null; question: string | null };

	/**
	 * Runs that have ended, by id. An ended run never changes again (only one
	 * waiting on the user resumes), so reopening a chat shows it without asking
	 * the server once more.
	 */
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a plain cache, nothing renders from it
	const endedRuns = new Map<string, RunState>();

	/** The run as the server has it now; null when it can't be loaded. */
	async function loadRun(id: string): Promise<RunState | null> {
		const ended = endedRuns.get(id);
		if (ended) return ended;
		const res = await fetch(`/api/agent-runs/${encodeURIComponent(id)}`).catch(() => null);
		if (!res?.ok) return null;
		const body = (await res.json().catch(() => null)) as {
			run?: AgentRun;
			messages?: { role: string; parts: unknown[] }[];
		} | null;
		if (!body?.run) return null;
		const latest =
			body.run.status === 'running'
				? { text: null, question: null }
				: latestRunReply(body.messages ?? []);
		const state = { run: body.run, reply: latest.text, question: latest.question };
		if (!isRunOpen(body.run.status)) endedRuns.set(id, state);
		return state;
	}
</script>

<script lang="ts">
	import { resolve } from '$app/paths';
	import { untrack } from 'svelte';
	import { agentDisplayName, formatRunError } from '$lib/agent-labels.js';
	import {
		AGENT_RUN_PHASE_LABEL,
		AGENT_RUN_PHASE_SHORT_LABEL,
		agentRunPhase,
		parseAgentRunOutput,
		replyPreview,
		toolRefusal,
		type AgentRunPhase
	} from '$lib/agent-run-tool.js';
	import { formatElapsed } from '$lib/formats.js';
	import { now } from '$lib/state/now.svelte.js';
	import { onServerEvent, onServerEventResync } from '$lib/state/events.svelte.js';
	import AgentRow, { type AgentRowTone } from './AgentRow.svelte';
	import AgentRowLinks from './AgentRowLinks.svelte';
	import AgentRowSection from './AgentRowSection.svelte';

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
	const refusal = $derived(toolRefusal(part));

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

	// What the opened row shows.
	const showReply = $derived(!!reply && phase === 'done');
	const showQuestion = $derived(phase === 'asking' && !!question);
	const showError = $derived(failed && !!errorText);
	const tone = $derived<AgentRowTone>(
		working
			? 'working'
			: phase === 'done'
				? 'done'
				: phase === 'asking'
					? 'asking'
					: failed
						? 'failed'
						: 'stopped'
	);
	/** Where the opened row leads: watch it work, answer it, or read the finished run. */
	const links = $derived.by(() => {
		const list: { href: string; label: string; live?: boolean; primary?: boolean }[] = [];
		if (phase === 'asking' && chatPath)
			list.push({ href: chatPath, label: 'Answer', primary: true });
		if (runPath) {
			list.push(
				working
					? { href: runPath, label: 'Watch live', live: true, primary: true }
					: { href: runPath, label: 'View run' }
			);
		}
		return list;
	});
	const hasBody = $derived(
		!!instructions || showReply || showQuestion || showError || links.length > 0
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
		const state = await loadRun(id);
		if (!state || seq !== refreshSeq) return;
		live = { ...state, source: 'fetched' };
	}

	// Check (and keep checking) whether the run an "already running" refusal points at is still busy.
	$effect(() => {
		const id = refusal?.runId;
		if (!id) return;
		let cancelled = false;
		const check = async () => {
			const state = await loadRun(id);
			// A run that is gone (deleted, or not this user's) has nothing left to watch.
			if (cancelled) return;
			busyStillOpen = state ? isRunOpen(state.run.status) : false;
			busyStartedAt = state?.run.startedAt ?? null;
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
</script>

{#snippet details()}
	<!-- While it works: watching it, then its task. Asking: the question, then answering it.
	     Once it's done: what it found first, then its task. -->
	{#if working}
		<AgentRowLinks {links} />
		{#if instructions}
			<AgentRowSection label="Task" text={instructions} />
		{/if}
	{/if}
	{#if showQuestion}
		<AgentRowSection label="Question for you" tone="question">
			{#if reply && reply.trim() !== question?.trim()}
				<p class="mb-1 text-xs text-muted-foreground">{reply}</p>
			{/if}
			<p class="text-[13px] leading-5 font-medium">{question}</p>
		</AgentRowSection>
	{/if}
	{#if showReply}
		<AgentRowSection label="Result" text={reply ?? ''} markdown>
			{#snippet note()}
				{#if parsed?.truncated && !current}
					<p class="mt-1 text-xs text-muted-foreground">Shortened here; the run has all of it.</p>
				{/if}
			{/snippet}
		</AgentRowSection>
	{/if}
	{#if showError}
		<AgentRowSection label="Error" text={errorText ?? ''} tone="error" />
	{/if}
	{#if !working}
		{#if instructions && !showQuestion}
			<AgentRowSection label="Task" text={instructions} />
		{/if}
		<AgentRowLinks {links} />
	{/if}
{/snippet}

<!-- "Asking" at every width: the question itself is on the second line. -->
<AgentRow
	{tone}
	status={phase === 'asking' ? 'Asking' : AGENT_RUN_PHASE_LABEL[phase]}
	statusShort={phase === 'asking' ? undefined : AGENT_RUN_PHASE_SHORT_LABEL[phase]}
	{title}
	titleHint={agentName ?? undefined}
	{activity}
	activityInBody={showReply || showQuestion || showError}
	{duration}
	durationHint={duration ? (working ? `Running for ${duration}` : `Took ${duration}`) : undefined}
	bind:open
	body={hasBody ? details : undefined}
/>
<span class="sr-only" aria-live="polite">
	{seenWorking && !working ? `${title}: ${AGENT_RUN_PHASE_LABEL[phase]}` : ''}
</span>
