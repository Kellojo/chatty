<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GitPullRequestIcon from '@lucide/svelte/icons/git-pull-request';
	import GitPullRequestCreateIcon from '@lucide/svelte/icons/git-pull-request-create';
	import { agentIsFree, hasPullRequestWork, pullRequestNumber } from '$lib/coding-task-details.js';
	import type { CodingConversation, CodingTaskStatus } from '$lib/coding-environments.js';
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

	/** One quiet style for every state: a dot plus muted text, tinted only when it needs you. */
	const STATUS: Record<CodingTaskStatus, { label: string; dot: string; tone: string }> = {
		starting: { label: 'Starting', dot: 'bg-info animate-pulse', tone: 'text-muted-foreground' },
		running: { label: 'Working', dot: 'bg-info animate-pulse', tone: 'text-muted-foreground' },
		awaiting_input: {
			label: 'Waiting for you',
			dot: 'bg-amber-500',
			tone: 'text-amber-700 dark:text-amber-400'
		},
		idle: { label: 'Idle', dot: 'bg-muted-foreground', tone: 'text-muted-foreground' },
		failed: { label: 'Failed', dot: 'bg-destructive', tone: 'text-destructive' },
		interrupted: { label: 'Interrupted', dot: 'bg-muted-foreground', tone: 'text-muted-foreground' }
	};

	const status = $derived(STATUS[coding.status] ?? STATUS.idle);
	/** A working task shows how long its run has been going instead of a status badge. */
	const runStartedAt = $derived(
		coding.status === 'running' || coding.status === 'starting' ? coding.runStartedAt : null
	);
	const branch = $derived(coding.branch ?? coding.baseBranch);
</script>

<!-- Only what changes how you act: where the work lives, how big it is, its state and the PR.
     Project, environment and model live in the ⋯ menu. -->
<div class="flex min-w-0 flex-1 items-center gap-2 text-sm">
	{#if title}
		<h1 class="min-w-0 shrink truncate font-medium" {title}>{title}</h1>
	{/if}
	{#if branch}
		<span
			class={[
				'min-w-0 items-center gap-1 text-muted-foreground',
				title ? 'hidden shrink-[2] md:flex' : 'flex'
			]}
			title={coding.branch ? `Branch ${coding.branch}` : 'Base branch'}
		>
			<GitBranchIcon class="size-3.5 shrink-0" />
			<span class="truncate font-mono text-xs">{branch}</span>
		</span>
	{/if}
	<DiffStat diff={coding.diff} />
	{#if runStartedAt}
		<CodingRunTimer startedAt={runStartedAt} class="shrink-0 text-muted-foreground" />
	{:else if coding.status !== 'idle'}
		<!-- Idle is the resting state and shows nothing. On phones the dot carries the state. -->
		<span
			class="inline-flex shrink-0 items-center gap-1.5 text-xs {status.tone}"
			title={coding.lastError ?? undefined}
		>
			<span class="size-1.5 rounded-full motion-reduce:animate-none {status.dot}" aria-hidden="true"
			></span>
			<span class="max-sm:sr-only">{status.label}</span>
		</span>
	{/if}
	<div class="ml-auto flex shrink-0 items-center gap-2">
		{#if coding.prUrl}
			{@const number = pullRequestNumber(coding.prUrl)}
			<Button
				href={coding.prUrl}
				target="_blank"
				rel="noopener noreferrer"
				variant="outline"
				size="sm"
				aria-label="Open pull request {number ?? ''}"
				title="Open pull request"
			>
				<GitPullRequestIcon />
				<span class="sm:hidden">{number ?? 'PR'}</span>
				<span class="hidden sm:inline">{number ? `PR ${number}` : 'Pull request'}</span>
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
