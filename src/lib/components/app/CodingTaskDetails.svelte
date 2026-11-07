<script lang="ts">
	import { toast } from 'svelte-sonner';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import type { CodingConversation } from '$lib/coding-environments.js';
	import { runtimeModeLabel } from '$lib/coding-task-details.js';
	import CopyIcon from '@lucide/svelte/icons/copy';

	/** What T3 knows about a coding task, rendered inside the conversation menu. */
	let {
		coding,
		environmentName = null
	}: {
		coding: CodingConversation;
		environmentName?: string | null;
	} = $props();

	/** Values that are identifiers rather than words. */
	const MONO = new Set(['Base branch', 'Model']);

	const rows = $derived(
		[
			['Project', coding.projectTitle],
			['Environment', environmentName],
			// The task's own branch is what matters; the base only when there is none yet.
			['Base branch', coding.branch ? null : coding.baseBranch],
			['Workspace', coding.workspaceMode === 'worktree' ? 'Separate worktree' : 'Project checkout'],
			['Model', coding.model],
			['Permissions', runtimeModeLabel(coding.runtimeMode)]
		].filter((row): row is [string, string] => !!row[1])
	);

	async function copyBranch() {
		if (!coding.branch) return;
		try {
			await navigator.clipboard.writeText(coding.branch);
			toast.success('Branch name copied');
		} catch {
			toast.error('Failed to copy');
		}
	}
</script>

<DropdownMenu.Label class="pt-2 text-xs font-medium text-muted-foreground"
	>Task details</DropdownMenu.Label
>
{#if coding.branch}
	<!-- The branch is the detail people act on, so it leads and copies on select. -->
	<DropdownMenu.Item onSelect={copyBranch} class="justify-between gap-4" title="Copy branch name">
		<span class="text-muted-foreground">Branch</span>
		<span class="flex min-w-0 items-center gap-1.5">
			<span class="truncate font-mono text-xs">{coding.branch}</span>
			<CopyIcon class="size-3.5 shrink-0 text-muted-foreground" />
		</span>
	</DropdownMenu.Item>
{/if}
<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 px-2 pt-1 pb-2 text-sm">
	{#each rows as [label, value] (label)}
		<dt class="text-muted-foreground">{label}</dt>
		<dd
			class="truncate text-right {MONO.has(label) ? 'font-mono text-xs leading-5' : ''}"
			title={value}
		>
			{value}
		</dd>
	{/each}
</dl>
