<script lang="ts">
	import { Badge, type BadgeVariant } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import FolderGit2Icon from '@lucide/svelte/icons/folder-git-2';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GitPullRequestIcon from '@lucide/svelte/icons/git-pull-request';
	import ServerIcon from '@lucide/svelte/icons/server';
	import type { CodingConversation, CodingTaskStatus } from '$lib/coding-environments.js';

	let {
		coding,
		environmentName
	}: {
		coding: CodingConversation;
		environmentName?: string | null;
	} = $props();

	const STATUS: Record<CodingTaskStatus, { label: string; variant: BadgeVariant; dot?: string }> = {
		starting: { label: 'Starting', variant: 'secondary', dot: 'bg-sky-500 animate-pulse' },
		running: { label: 'Working', variant: 'secondary', dot: 'bg-emerald-500 animate-pulse' },
		awaiting_input: { label: 'Waiting for you', variant: 'default' },
		idle: { label: 'Idle', variant: 'outline' },
		failed: { label: 'Failed', variant: 'destructive' },
		interrupted: { label: 'Interrupted', variant: 'outline' }
	};

	const status = $derived(STATUS[coding.status] ?? STATUS.idle);
	const branch = $derived(
		coding.workspaceMode === 'local'
			? (coding.branch ?? 'Project checkout')
			: (coding.branch ?? coding.baseBranch)
	);
</script>

<div class="flex min-h-9 min-w-0 flex-1 items-center gap-2 text-sm">
	<span class="flex min-w-0 items-center gap-1.5 font-medium" title="Project">
		<FolderGit2Icon class="size-4 shrink-0 text-muted-foreground" />
		<span class="truncate">{coding.projectTitle}</span>
	</span>
	{#if branch}
		<span
			class="hidden min-w-0 items-center gap-1 text-muted-foreground sm:flex"
			title={coding.branch ? 'Branch' : 'Base branch'}
		>
			<GitBranchIcon class="size-3.5 shrink-0" />
			<span class="truncate font-mono text-xs">{branch}</span>
		</span>
	{/if}
	<Badge variant={status.variant} class="gap-1.5" title={coding.lastError ?? undefined}>
		{#if status.dot}
			<span class="size-1.5 rounded-full {status.dot}"></span>
		{/if}
		{status.label}
	</Badge>
	<div class="ml-auto flex shrink-0 items-center gap-2">
		{#if environmentName}
			<span
				class="hidden items-center gap-1 text-xs text-muted-foreground md:flex"
				title="Coding environment"
			>
				<ServerIcon class="size-3.5" />
				{environmentName}
			</span>
		{/if}
		{#if coding.prUrl}
			<Button
				href={coding.prUrl}
				target="_blank"
				rel="noopener noreferrer"
				variant="outline"
				size="xs"
				aria-label="Open pull request"
			>
				<GitPullRequestIcon />
				<span class="hidden sm:inline">Pull request</span>
			</Button>
		{/if}
	</div>
</div>
