<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GitPullRequestCreateIcon from '@lucide/svelte/icons/git-pull-request-create';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import {
		canCreatePullRequest,
		pullRequestNumber,
		recoveryAction,
		type CodingRecoveryAction
	} from '$lib/coding-task-details.js';
	import type { CodingConversation } from '$lib/coding-environments.js';
	import { CODING_PR_STATE_STYLE, CODING_STATUS_STYLE } from '$lib/coding-status.js';
	import PullRequestIcon from './PullRequestIcon.svelte';
	import CodingRunTimer from './CodingRunTimer.svelte';
	import DiffStat from './DiffStat.svelte';
	import CodingBrowserPreview from './CodingBrowserPreview.svelte';
	import CodingDiffDialog from './CodingDiffDialog.svelte';
	import CodingTaskSettingsDialog from './CodingTaskSettingsDialog.svelte';

	let {
		coding,
		title = null,
		oncreatepr,
		onrecover
	}: {
		coding: CodingConversation;
		/** Task title, the header's main information. */
		title?: string | null;
		/** Asks the agent to commit, push and open a pull request. */
		oncreatepr?: () => void;
		/** Sends the follow-up of a failed or interrupted task ("Retry" / "Continue"). */
		onrecover?: (action: CodingRecoveryAction) => void;
	} = $props();

	const canCreatePr = $derived(!!oncreatepr && canCreatePullRequest(coding));
	const recovery = $derived(onrecover ? recoveryAction(coding) : null);

	const status = $derived(CODING_STATUS_STYLE[coding.status] ?? CODING_STATUS_STYLE.idle);
	/** A working task shows how long its run has been going instead of a status badge. */
	const runStartedAt = $derived(
		coding.status === 'running' || coding.status === 'starting' ? coding.runStartedAt : null
	);
	const branch = $derived(coding.branch ?? coding.baseBranch);
	/** Browser tabs live on the T3 thread, so there is nothing to show before it exists. */
	const hasThread = $derived(!!coding.threadId && !!coding.environmentId);
	let previewOpen = $state(false);
	let diffOpen = $state(false);
	let settingsOpen = $state(false);
	const hasChanges = $derived(
		!!coding.diff && (coding.diff.insertions > 0 || coding.diff.deletions > 0)
	);
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
			{#if hasThread && hasChanges}
				<button
					type="button"
					class="shrink-0 rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					aria-label="Show the changed files"
					onclick={() => (diffOpen = true)}
				>
					<DiffStat diff={coding.diff} />
				</button>
			{:else}
				<DiffStat diff={coding.diff} />
			{/if}
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
		{#if recovery}
			<Button
				variant="outline"
				size="sm"
				title={recovery.hint}
				aria-label="{recovery.label}: {recovery.hint}"
				onclick={() => onrecover?.(recovery)}
			>
				<RotateCcwIcon />
				<span class="hidden sm:inline">{recovery.label}</span>
			</Button>
		{/if}
		{#if coding.environmentId}
			<Button
				variant="ghost"
				size="icon-sm"
				class="text-muted-foreground hover:text-foreground"
				title="Model and permissions"
				aria-label="Change the model and permissions"
				onclick={() => (settingsOpen = true)}
			>
				<SlidersHorizontalIcon />
			</Button>
		{/if}
		{#if hasThread}
			<Button
				variant="ghost"
				size="icon-sm"
				class="text-muted-foreground hover:text-foreground"
				title="Browser preview"
				aria-label="Open the agent's browser preview"
				onclick={() => (previewOpen = true)}
			>
				<GlobeIcon />
			</Button>
		{/if}
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
		{:else if canCreatePr}
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

{#if hasThread}
	<CodingBrowserPreview conversationId={coding.conversationId} bind:open={previewOpen} />
	<CodingDiffDialog conversationId={coding.conversationId} bind:open={diffOpen} />
{/if}
{#if coding.environmentId}
	<CodingTaskSettingsDialog {coding} bind:open={settingsOpen} />
{/if}
