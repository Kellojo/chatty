<script lang="ts">
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import CircleSlashIcon from '@lucide/svelte/icons/circle-slash';
	import PlayIcon from '@lucide/svelte/icons/play';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Markdown } from '$lib/components/ai/markdown/index.js';
	import {
		parseCodingTaskProposal,
		parseCodingTaskProposalTarget
	} from '$lib/coding-task-proposal.js';
	import { toolRefusal } from '$lib/agent-run-tool.js';
	import { cn } from '$lib/utils.js';
	import { resolve } from '$app/paths';
	import { untrack } from 'svelte';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import GitPullRequestIcon from '@lucide/svelte/icons/git-pull-request';
	import { CODING_STATUS_STYLE } from '$lib/coding-status.js';
	import { proposedCodingTasks } from '$lib/state/proposed-coding-tasks.svelte.js';
	import HandoffDialog from './HandoffDialog.svelte';
	import { getChatViewContext } from './chat-view-context.js';

	/**
	 * A `propose_coding_task` call: the task the chat model wrote, with a button
	 * that opens the hand-off dialog on it. Nothing runs until the user starts it
	 * there, after choosing where and reviewing (or editing) the task.
	 */
	type ToolPart = {
		toolCallId: string;
		state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
		input?: unknown;
		output?: unknown;
		errorText?: string;
	};

	let { part, active = true }: { part: ToolPart; active?: boolean } = $props();

	const targets = getChatViewContext();
	const handoff = $derived(targets?.());
	const canStart = $derived(
		!!handoff && (handoff.codingEnvironments.length > 0 || handoff.codingAgents.length > 0)
	);
	// The chat view remounts per chat, so its id is fixed for this card.
	const chatId = untrack(() => targets?.().conversationId ?? null);
	const startedTasks = chatId ? proposedCodingTasks(chatId) : null;
	/** The task this proposal was started as; null until it is. */
	const started = $derived(startedTasks?.byToolCall(part.toolCallId) ?? null);

	/** The project the tool checked; only known once it returned. */
	const target = $derived(
		part.state === 'output-available' ? parseCodingTaskProposalTarget(part.output) : null
	);
	const proposal = $derived.by(() => {
		const parsed = parseCodingTaskProposal(part.input);
		if (!parsed) return null;
		const source = chatId ? { conversationId: chatId, toolCallId: part.toolCallId } : null;
		return { ...parsed, target, source };
	});
	/** An idle task has finished its run; "Idle" reads oddly for that. */
	const startedStatus = $derived.by(() => {
		if (!started) return null;
		const style = CODING_STATUS_STYLE[started.coding.status];
		return started.coding.status === 'idle'
			? { ...style, label: 'Done', dot: 'bg-success' }
			: style;
	});
	const incomplete = $derived(part.state === 'input-streaming' || part.state === 'input-available');
	const writing = $derived(incomplete && active);
	const stopped = $derived(incomplete && !active);
	const refusal = $derived(toolRefusal(part)?.reason ?? null);
	const ready = $derived(part.state === 'output-available' && !refusal && !!proposal);

	let expanded = $state(false);
	let clipped = $state(false);
	let dialogMounted = $state(false);
	let dialogOpen = $state(false);

	function review() {
		dialogMounted = true;
		dialogOpen = true;
	}

	/** Tracks whether the collapsed task is cut off, so "Show all" only appears when it is. */
	function trackClipping(node: HTMLElement) {
		const update = () => (clipped = node.scrollHeight - node.clientHeight > 4);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(node);
		if (node.firstElementChild) observer.observe(node.firstElementChild);
		return () => observer.disconnect();
	}
</script>

<div class="my-2 w-full min-w-0 overflow-hidden rounded-xl border border-border bg-card text-sm">
	<div class="flex min-w-0 items-start gap-3 px-4 pt-3.5 pb-2.5">
		<div
			class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
			aria-hidden="true"
		>
			<SquareTerminalIcon class="size-4" />
		</div>
		<div class="flex min-w-0 flex-1 flex-col">
			<span class="text-xs text-muted-foreground">Proposed coding task</span>
			<span class="truncate font-medium" title={proposal?.title ?? undefined}>
				{proposal?.title ?? (writing ? 'Writing the task…' : 'Coding task')}
			</span>
			{#if target}
				<span
					class="truncate text-xs text-muted-foreground"
					title={`${target.projectTitle} on ${target.environmentName}`}
				>
					Runs in <span class="font-medium text-foreground/80">{target.projectTitle}</span>
					on <span class="italic">{target.environmentName}</span>
				</span>
			{/if}
		</div>
		{#if writing}
			<Loader2Icon
				class="mt-1 size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
				aria-label="Writing the task"
			/>
		{/if}
	</div>

	{#if proposal}
		<div class="relative border-t border-border bg-background/60">
			<div {@attach trackClipping} class={cn('px-4 py-3', !expanded && 'max-h-48 overflow-hidden')}>
				<Markdown
					class="w-full max-w-none text-sm [&_h1]:mt-1 [&_h1]:text-base [&_h2]:mt-1 [&_h2]:text-sm [&_h3]:text-sm"
					content={proposal.prompt}
					streaming={writing}
				/>
			</div>
			{#if clipped && !expanded}
				<div
					aria-hidden="true"
					class="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-card to-transparent"
				></div>
			{/if}
		</div>
	{/if}

	{#if refusal}
		<p class="flex items-start gap-2 border-t border-border px-4 py-3 text-destructive">
			<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			{refusal}
		</p>
	{:else if stopped}
		<p class="flex items-center gap-2 border-t border-border px-4 py-3 text-muted-foreground">
			<CircleSlashIcon class="size-4 shrink-0" aria-hidden="true" />
			Stopped before the task was ready
		</p>
	{:else if ready && started && startedStatus}
		<!-- Started: one task per proposal, so the card follows it instead of offering a start. -->
		<div
			class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-3 text-xs"
		>
			<Button
				size="sm"
				variant="outline"
				href={resolve('/(app)/chat/[id]', { id: started.conversationId })}
			>
				Open task
				<ArrowUpRightIcon class="size-4" />
			</Button>
			{#if clipped || expanded}
				<Button size="sm" variant="ghost" onclick={() => (expanded = !expanded)}>
					{expanded ? 'Show less' : 'Show all'}
				</Button>
			{/if}
			<span class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
				<span class={cn('inline-flex items-center gap-1.5 font-medium', startedStatus.tone)}>
					<span class={cn('size-1.5 rounded-full', startedStatus.dot)} aria-hidden="true"></span>
					Started · {startedStatus.label}
				</span>
				{#if started.coding.prUrl}
					<!-- eslint-disable svelte/no-navigation-without-resolve -- an external PR link -->
					<a
						href={started.coding.prUrl}
						target="_blank"
						rel="noopener"
						class="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
					>
						<GitPullRequestIcon class="size-3.5" aria-hidden="true" />
						Pull request
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{:else if started.coding.branch}
					<span class="truncate font-mono text-muted-foreground" title={started.coding.branch}>
						{started.coding.branch}
					</span>
				{/if}
			</span>
		</div>
	{:else if ready}
		<div
			class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-3 text-xs text-muted-foreground"
		>
			<Button size="sm" disabled={!canStart} onclick={review}>
				<PlayIcon class="size-4" />
				Review & start
			</Button>
			{#if clipped || expanded}
				<Button size="sm" variant="ghost" onclick={() => (expanded = !expanded)}>
					{expanded ? 'Show less' : 'Show all'}
				</Button>
			{/if}
			<span class="min-w-0 flex-1">
				{canStart
					? 'Nothing runs until you start it.'
					: 'Connect a coding environment in Settings → Coding environments to start it.'}
			</span>
		</div>
	{/if}
</div>

{#if dialogMounted && handoff && proposal}
	<HandoffDialog
		bind:open={dialogOpen}
		conversationId={handoff.conversationId}
		codingEnvironments={handoff.codingEnvironments}
		codingAgents={handoff.codingAgents}
		{proposal}
		onstarted={() => startedTasks?.refresh()}
	/>
{/if}
