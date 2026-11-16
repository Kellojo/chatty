<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleSlashIcon from '@lucide/svelte/icons/circle-slash';
	import GitPullRequestIcon from '@lucide/svelte/icons/git-pull-request';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { CodingTaskNotice } from '$lib/coding-task-proposal.js';
	import { cn } from '$lib/utils.js';

	/** A coding task started from this chat's proposal reported back: it finished. */
	let { notice }: { notice: CodingTaskNotice } = $props();

	const outcome = $derived(
		notice.status === 'completed'
			? { icon: CircleCheckIcon, word: 'finished', tone: 'text-success' }
			: notice.status === 'failed'
				? { icon: TriangleAlertIcon, word: 'failed', tone: 'text-destructive' }
				: { icon: CircleSlashIcon, word: 'was interrupted', tone: 'text-muted-foreground' }
	);
	const Icon = $derived(outcome.icon);
	const linkClass =
		'inline-flex items-center gap-1 rounded font-medium underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none';
</script>

<div
	class="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
	role="status"
>
	<span class="flex min-w-0 flex-1 items-center gap-2">
		<Icon class={cn('size-4 shrink-0', outcome.tone)} aria-hidden="true" />
		<span class="min-w-0 truncate">
			Coding task <span class="font-medium">{notice.title}</span>
			<span class="text-muted-foreground">in {notice.projectTitle}</span>
			{outcome.word}
		</span>
	</span>
	<span class="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
		{#if notice.prUrl}
			<!-- eslint-disable svelte/no-navigation-without-resolve -- an external PR link -->
			<a href={notice.prUrl} target="_blank" rel="noopener" class={linkClass}>
				<GitPullRequestIcon class="size-3.5" aria-hidden="true" />
				Pull request
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/if}
		<a href={resolve('/(app)/chat/[id]', { id: notice.conversationId })} class={linkClass}>
			Open task
			<ArrowUpRightIcon class="size-3.5" aria-hidden="true" />
		</a>
	</span>
</div>
