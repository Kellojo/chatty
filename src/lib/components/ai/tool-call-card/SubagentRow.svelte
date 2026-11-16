<script lang="ts">
	import { resolve } from '$app/paths';
	import { getChatViewContext } from '$lib/components/app/chat-view-context.js';
	import { replyPreview, toolRefusal } from '$lib/agent-run-tool.js';
	import { formatElapsed } from '$lib/formats.js';
	import { now } from '$lib/state/now.svelte.js';
	import { displayReport, parseSubagentToolResult, type SubagentInfo } from '$lib/subagent-tool.js';
	import AgentRow, { type AgentRowTone } from './AgentRow.svelte';
	import AgentRowLinks from './AgentRowLinks.svelte';
	import AgentRowSection from './AgentRowSection.svelte';

	/**
	 * A `run_subagent` call, shown like a coding task's subagents: what it works
	 * on, then its latest step or its report's first line. Opening it shows the
	 * task, the report and where to watch it live or read its transcript.
	 */
	type ToolPart = {
		toolCallId: string;
		state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
		input?: unknown;
		output?: unknown;
		errorText?: string;
	};

	let { part, active = true }: { part: ToolPart; active?: boolean } = $props();

	let open = $state(false);

	const chat = getChatViewContext();
	const args = $derived(
		(part.input && typeof part.input === 'object' ? part.input : {}) as {
			description?: unknown;
			prompt?: unknown;
		}
	);
	const description = $derived(
		typeof args.description === 'string' && args.description.trim()
			? args.description.trim()
			: 'Subagent'
	);
	const task = $derived(typeof args.prompt === 'string' ? args.prompt.trim() : '');
	const incomplete = $derived(part.state === 'input-streaming' || part.state === 'input-available');
	const callRunning = $derived(incomplete && active);
	const result = $derived(
		part.state === 'output-available' ? parseSubagentToolResult(part.output) : null
	);
	/** The tool turned the call down before a subagent started (nesting, too many, no tools). */
	const refusal = $derived(result ? null : (toolRefusal(part)?.reason ?? null));

	/**
	 * The subagent, looked up by this call: while it works (the call itself
	 * returns only at the end), or once for a call cut off without a result.
	 */
	let live = $state<SubagentInfo | null>(null);

	type Phase = 'starting' | 'running' | 'done' | 'failed' | 'stopped' | 'refused' | 'interrupted';
	const phase = $derived.by((): Phase => {
		if (refusal) return 'refused';
		if (result) {
			return result.status === 'completed'
				? 'done'
				: result.status === 'stopped'
					? 'stopped'
					: 'failed';
		}
		if (callRunning) return live ? 'running' : 'starting';
		// The chat's reply ended (stopped, or the server restarted) before the report came back.
		return 'interrupted';
	});
	/** The chat's call ended, but the subagent it started is still at work (watchable). */
	const orphanRunning = $derived(phase === 'interrupted' && live?.status === 'running');
	const working = $derived(phase === 'starting' || phase === 'running' || orphanRunning);
	const failed = $derived(phase === 'failed' || phase === 'refused');
	const tone = $derived<AgentRowTone>(
		working ? 'working' : phase === 'done' ? 'done' : failed ? 'failed' : 'stopped'
	);
	const STATUS: Record<Phase, string> = {
		starting: 'Starting',
		running: 'Running',
		done: 'Done',
		failed: 'Failed',
		stopped: 'Stopped',
		refused: "Couldn't start",
		interrupted: 'Interrupted'
	};
	const status = $derived(orphanRunning ? 'Running' : STATUS[phase]);

	const subagentId = $derived(result?.conversationId ?? live?.id ?? null);
	const transcriptHref = $derived(
		subagentId ? resolve('/(app)/subagents/[id]', { id: subagentId }) : null
	);
	const startedAt = $derived(result?.startedAt ?? live?.startedAt ?? null);
	const duration = $derived.by(() => {
		if (!startedAt) return null;
		if (working) return formatElapsed(now() - startedAt);
		return result?.endedAt ? formatElapsed(result.endedAt - startedAt) : null;
	});

	const report = $derived(result?.result ? displayReport(result.result) : null);
	const errorText = $derived(refusal ?? (failed ? (result?.error ?? 'The subagent failed') : null));
	const activity = $derived.by((): string => {
		switch (phase) {
			case 'starting':
				return 'Handing off the task…';
			case 'running': {
				const progress = live?.progress;
				if (!progress?.current) return 'Working on it in its own context…';
				return `Step ${progress.steps} · ${progress.current}`;
			}
			case 'done':
				return replyPreview(report) ?? 'Finished without a report';
			case 'failed':
			case 'refused':
				return errorText?.split('\n')[0] ?? 'The subagent failed';
			case 'stopped':
				return 'Stopped before it finished';
			case 'interrupted':
				return orphanRunning
					? "Still working; its report won't return here"
					: live
						? "Its report didn't reach this chat"
						: 'Stopped before it reported back';
		}
	});
	const links = $derived(
		transcriptHref
			? [
					working
						? { href: transcriptHref, label: 'Watch live', live: true, primary: true }
						: { href: transcriptHref, label: 'Open transcript' }
				]
			: []
	);
	const hasBody = $derived(!!task || !!report || !!errorText || links.length > 0);

	// While the call works: find the subagent, then keep following its progress
	// (its start time drives the clock, its latest step the activity line). For an
	// interrupted call: look once, so its transcript can still be opened.
	$effect(() => {
		const interrupted = phase === 'interrupted';
		if ((!callRunning && !interrupted) || !chat) return;
		const parent = chat().conversationId;
		const toolCallId = part.toolCallId;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		// Gentle on a local server: slower while not found yet, a steady pace once it works.
		let delay = 1500;
		const look = async () => {
			const query = new URLSearchParams({ parent, toolCallId });
			const res = await fetch(`/api/subagents?${query}`).catch(() => null);
			const body = res?.ok ? ((await res.json()) as { subagent: SubagentInfo | null }) : null;
			if (cancelled) return;
			if (body?.subagent) live = body.subagent;
			if (interrupted) return;
			timer = setTimeout(look, body?.subagent ? 2500 : delay);
			if (!body?.subagent) delay = Math.min(delay * 1.5, 5000);
		};
		timer = setTimeout(look, interrupted ? 0 : 400);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	/** Announce how it ended only to someone who saw it working, not for rows loaded finished. */
	let seenWorking = $state(false);
	$effect(() => {
		if (working) seenWorking = true;
	});
</script>

{#snippet details()}
	<!-- While it works: watching it, then what it was asked. Once it's done: what it found first. -->
	{#if working}
		<AgentRowLinks {links} />
		{#if task}
			<AgentRowSection label="Task" text={task} />
		{/if}
	{/if}
	{#if report}
		<AgentRowSection label="Result" text={report} markdown>
			{#snippet note()}
				{#if result?.truncated}
					<p class="mt-1 text-xs text-muted-foreground">
						Shortened here; the transcript has all of it.
					</p>
				{/if}
			{/snippet}
		</AgentRowSection>
	{/if}
	{#if errorText}
		<AgentRowSection label="Error" text={errorText} tone="error" />
	{/if}
	{#if !working}
		{#if task}
			<AgentRowSection label="Task" text={task} />
		{/if}
		<AgentRowLinks {links} />
	{/if}
{/snippet}

<AgentRow
	{tone}
	{status}
	title={description}
	titleHint={`Subagent: ${description}`}
	{activity}
	activityInBody={(phase === 'done' && !!report) || !!errorText}
	{duration}
	durationHint={duration ? (working ? `Running for ${duration}` : `Took ${duration}`) : undefined}
	bind:open
	body={hasBody ? details : undefined}
/>
<span class="sr-only" aria-live="polite">
	{seenWorking && !working ? `Subagent ${description}: ${status}` : ''}
</span>
