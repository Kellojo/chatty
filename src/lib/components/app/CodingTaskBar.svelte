<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GitPullRequestCreateIcon from '@lucide/svelte/icons/git-pull-request-create';
	import { agentIsFree, hasPullRequestWork, pullRequestNumber } from '$lib/coding-task-details.js';
	import type { CodingConversation } from '$lib/coding-environments.js';
	import { CODING_PR_STATE_STYLE, CODING_STATUS_STYLE } from '$lib/coding-status.js';
	import PullRequestIcon from './PullRequestIcon.svelte';
	import CodingRunTimer from './CodingRunTimer.svelte';
	import DiffStat from './DiffStat.svelte';

	let {
		coding,
		title = null,
		oncreatepr
	}: {
		coding: CodingConversation;
		/** Task title, the header's main information. */
		title?: string | null;
		/** Asks the agent to commit, push and open a pull request. */
		oncreatepr?: () => void;
	} = $props();

	const canCreatePr = $derived(!!oncreatepr && hasPullRequestWork(coding));
	const agentFree = $derived(agentIsFree(coding));

	const status = $derived(CODING_STATUS_STYLE[coding.status] ?? CODING_STATUS_STYLE.idle);
	/** A working task shows how long its run has been going instead of a status badge. */
	const runStartedAt = $derived(
		coding.status === 'running' || coding.status === 'starting' ? coding.runStartedAt : null
	);
	const branch = $derived(coding.branch ?? coding.baseBranch);
</script>

<!-- Only what changes how you act: where the work lives, how big it is, its state and the PR.
     Project, environment and model live in the ⋯ menu. Two lines so the title gets the full
     width and the details stay readable instead of being truncated or hidden. -->
<div class="flex min-w-0 flex-1 items-center gap-2 text-sm">
	<div class="flex min-w-0 flex-1 flex-col">
		{#if title}
			<h1 class="min-w-0 truncate leading-5 font-medium" {title}>{title}</h1>
		{/if}
		<div class="flex min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground">
			{#if branch}
				<span
					class="flex min-w-0 items-center gap-1"
					title={coding.branch ? `Branch ${coding.branch}` : 'Base branch'}
				>
					<GitBranchIcon class="size-3 shrink-0" />
					<span class="truncate font-mono">{branch}</span>
				</span>
			{/if}
			<DiffStat diff={coding.diff} />
			{#if runStartedAt}
				<CodingRunTimer startedAt={runStartedAt} class="shrink-0" />
			{:else if coding.status !== 'idle'}
				<!-- Idle is the resting state and shows nothing. -->
				<span
					class="inline-flex shrink-0 items-center gap-1.5 {status.tone}"
					title={coding.lastError ?? undefined}
				>
					<span
						class="size-1.5 rounded-full motion-reduce:animate-none {status.dot}"
						aria-hidden="true"
					></span>
					{status.label}
				</span>
			{/if}
		</div>
	</div>
	<div class="ml-auto flex shrink-0 items-center gap-2">
		{#if coding.prUrl}
			{@const number = pullRequestNumber(coding.prUrl)}
			{@const prState = coding.prState ? CODING_PR_STATE_STYLE[coding.prState].label : null}
			<Button
				href={coding.prUrl}
				target="_blank"
				rel="noopener noreferrer"
				variant="outline"
				size="sm"
				aria-label="Open pull request {number ?? ''}{prState ? ` (${prState.toLowerCase()})` : ''}"
				title={prState ? `Open pull request (${prState.toLowerCase()})` : 'Open pull request'}
			>
				<PullRequestIcon state={coding.prState} />
				<span class="sm:hidden">{number ?? 'PR'}</span>
				<span class="hidden sm:inline">{number ? `PR ${number}` : 'Pull request'}</span>
				{#if prState}
					<span class="hidden text-muted-foreground sm:inline">· {prState}</span>
				{/if}
			</Button>
		{:else if canCreatePr && agentFree}
			<!-- Offered only once the agent is free; a disabled button mid-run is just noise.
			     On phones it moves into the ⋯ menu, where it can carry a readable label. -->
			<Button
				variant="outline"
				size="sm"
				class="max-sm:hidden"
				title="Ask the agent to commit, push and open a pull request"
				aria-label="Create pull request"
				onclick={() => oncreatepr?.()}
			>
				<GitPullRequestCreateIcon />
				<span class="hidden sm:inline">Create PR</span>
			</Button>
		{/if}
	</div>
</div>
