<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GitPullRequestCreateIcon from '@lucide/svelte/icons/git-pull-request-create';
	import AppWindowIcon from '@lucide/svelte/icons/app-window';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import { canCreatePullRequest, pullRequestNumber } from '$lib/coding-task-details.js';
	import type { CodingConversation } from '$lib/coding-environments.js';
	import type { CodingBrowserActivity } from '$lib/coding-preview.js';
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
		environmentName = null,
		oncreatepr,
		settingsOpen = $bindable(false),
		previewOpen = $bindable(false),
		browserActivity = null
	}: {
		coding: CodingConversation;
		/** Task title, the header's main information. */
		title?: string | null;
		/** Where the task runs; named in the project's tooltip. */
		environmentName?: string | null;
		/** Asks the agent to commit, push and open a pull request. */
		oncreatepr?: () => void;
		/** The model/permissions dialog; bindable so the phone ⋯ menu can open it. */
		settingsOpen?: boolean;
		/** The browser preview; bindable so the phone ⋯ menu can open it. */
		previewOpen?: boolean;
		/** The agent's browser use in its current run; opens the preview's picture-in-picture. */
		browserActivity?: CodingBrowserActivity | null;
	} = $props();

	const canCreatePr = $derived(!!oncreatepr && canCreatePullRequest(coding));

	const status = $derived(CODING_STATUS_STYLE[coding.status] ?? CODING_STATUS_STYLE.idle);
	/** A working task shows how long its run has been going instead of a status badge. */
	const runStartedAt = $derived(
		coding.status === 'running' || coding.status === 'starting' ? coding.runStartedAt : null
	);
	const branch = $derived(coding.branch ?? coding.baseBranch);
	/** Runs in the project checkout itself rather than a worktree on its own branch. */
	const local = $derived(coding.workspaceMode === 'local');
	/** Browser tabs live on the T3 thread, so there is nothing to show before it exists. */
	const hasThread = $derived(!!coding.threadId && !!coding.environmentId);
	let diffOpen = $state(false);
	const hasChanges = $derived(
		!!coding.diff && (coding.diff.insertions > 0 || coding.diff.deletions > 0)
	);
</script>

<!-- Only what changes how you act: where the work lives, how big it is, its state and the PR.
     The project leads the details on wider screens; environment and model live in the ⋯ menu.
     Two lines so the title gets the full width and the details stay readable. -->
<div class="flex min-w-0 flex-1 items-center gap-2 text-sm">
	<div class="flex min-w-0 flex-1 flex-col">
		{#if title}
			<h1
				class="min-w-0 truncate text-[15px] leading-5 font-semibold sm:font-medium md:text-base"
				{title}
			>
				{title}
			</h1>
		{/if}
		<div class="flex min-w-0 items-center gap-2.5 text-xs leading-4 text-muted-foreground">
			{#if coding.projectTitle}
				<!-- Phones show neither project nor branch: both are in the ⋯ menu (the branch copies
				     from there), leaving the line to what changes: the diff and the run state.
				     The project keeps its width before the branch does: it's the more useful of the two. -->
				<span
					class="flex max-w-48 min-w-0 shrink items-center gap-1 font-medium text-foreground/80 max-sm:hidden lg:max-w-56"
					title={environmentName
						? `Project ${coding.projectTitle} on ${environmentName}`
						: `Project ${coding.projectTitle}`}
				>
					<FolderIcon class="size-3.5 shrink-0" />
					<span class="truncate">{coding.projectTitle}</span>
				</span>
			{/if}
			{#if branch}
				<span
					class="flex min-w-0 shrink-[2] items-center gap-1 max-sm:hidden"
					title={local
						? `Working directly in the project checkout on ${branch}`
						: coding.branch
							? `Branch ${coding.branch}`
							: `Base branch ${branch}`}
				>
					<GitBranchIcon class="size-3.5 shrink-0" />
					<span class="truncate font-mono">{branch}</span>
					{#if local}
						<span class="shrink-0">· Local checkout</span>
					{/if}
				</span>
			{/if}
			{#if hasThread && hasChanges}
				<button
					type="button"
					class="-mx-1 shrink-0 cursor-pointer rounded-sm px-1 underline decoration-muted-foreground/40 decoration-dotted underline-offset-2 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					title="Show the changed files"
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
	<!-- Quiet icons first, then the actions. On phones only the PR stays; settings and
	     the preview move into the ⋯ menu. -->
	<div class="ml-auto flex shrink-0 items-center gap-1">
		{#if coding.environmentId}
			<Button
				variant="ghost"
				size="icon-sm"
				class="text-muted-foreground hover:text-foreground max-sm:hidden"
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
				class="text-muted-foreground hover:text-foreground max-sm:hidden"
				title="Browser preview"
				aria-label="Open the agent's browser preview"
				onclick={() => (previewOpen = true)}
			>
				<AppWindowIcon />
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
	<CodingBrowserPreview
		conversationId={coding.conversationId}
		bind:open={previewOpen}
		activity={browserActivity}
	/>
	<CodingDiffDialog conversationId={coding.conversationId} bind:open={diffOpen} />
{/if}
{#if coding.environmentId}
	<CodingTaskSettingsDialog {coding} bind:open={settingsOpen} />
{/if}
