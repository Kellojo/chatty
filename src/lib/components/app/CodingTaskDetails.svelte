<script lang="ts">
	import { toast } from 'svelte-sonner';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import type { CodingConversation } from '$lib/coding-environments.js';
	import { autonomyFromRuntimeMode, runtimeModeLabel } from '$lib/coding-task-details.js';
	import { AUTONOMY_OPTIONS } from '$lib/state/coding-task.svelte.js';
	import CopyIcon from '@lucide/svelte/icons/copy';

	/** What T3 knows about a coding task, rendered inside the conversation menu. */
	let {
		coding,
		environmentName = null
	}: {
		coding: CodingConversation;
		environmentName?: string | null;
	} = $props();

	const uid = $props.id();
	const headingId = `${uid}-heading`;

	type Row = { label: string; value: string; mono?: boolean; hint?: string };

	const permissionHint = $derived(
		AUTONOMY_OPTIONS.find((o) => o.value === autonomyFromRuntimeMode(coding.runtimeMode))?.hint
	);

	const rows = $derived(
		(
			[
				{ label: 'Project', value: coding.projectTitle },
				{ label: 'Environment', value: environmentName },
				{
					label: 'Workspace',
					value: coding.workspaceMode === 'worktree' ? 'Separate worktree' : 'Project checkout'
				},
				// The task's own branch is what matters; the base only when there is none yet.
				{ label: 'Base branch', value: coding.branch ? null : coding.baseBranch, mono: true },
				{ label: 'Model', value: coding.model, mono: true },
				{
					label: 'Permissions',
					value: runtimeModeLabel(coding.runtimeMode),
					hint: permissionHint
				}
			] as { label: string; value: string | null; mono?: boolean; hint?: string }[]
		).filter((row): row is Row => !!row.value)
	);

	/**
	 * Branch names share prefixes ("claude/…", "feature/…"), so a long one keeps
	 * its end and gives up the middle, cutting at a word break where it can.
	 */
	const TAIL = 18;
	const branchSplit = $derived.by(() => {
		const branch = coding.branch ?? '';
		if (branch.length <= TAIL * 2) return { head: branch, tail: '' };
		const from = branch.length - TAIL;
		const cut = branch.slice(from).search(/[-/_.]/);
		const at = cut === -1 ? from : from + cut + 1;
		return { head: branch.slice(0, at), tail: branch.slice(at) };
	});

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

<DropdownMenu.Group aria-labelledby={headingId}>
	<DropdownMenu.Label id={headingId} class="pt-2.5 pb-2 text-xs font-medium text-muted-foreground">
		Task details
	</DropdownMenu.Label>
	{#if coding.branch}
		<!-- The branch is the detail people act on, so it leads and copies on select. -->
		<DropdownMenu.Item
			onSelect={copyBranch}
			class="justify-between gap-4 py-[3px] text-[13px] font-normal"
			title={`Copy ${coding.branch}`}
			aria-label={`Branch ${coding.branch}, copy name`}
		>
			<span class="text-muted-foreground">Branch</span>
			<!-- Icon first, so the value's right edge lines up with the rows below. -->
			<span class="flex min-w-0 items-center gap-1.5">
				<CopyIcon
					class="size-3.5 shrink-0 text-muted-foreground group-data-highlighted/dropdown-menu-item:text-foreground"
				/>
				<span class="flex min-w-0 font-mono leading-5 text-foreground/90">
					<span class="truncate">{branchSplit.head}</span>
					{#if branchSplit.tail}<span class="shrink-0">{branchSplit.tail}</span>{/if}
				</span>
			</span>
		</DropdownMenu.Item>
	{/if}
	<dl
		class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 px-3 pb-2.5 text-[13px] leading-5 {coding.branch
			? 'pt-[3px]'
			: 'pt-1'}"
	>
		{#each rows as row (row.label)}
			<dt class="text-muted-foreground">{row.label}</dt>
			<dd
				class="truncate text-right text-foreground/90 {row.mono ? 'font-mono' : ''}"
				title={row.hint ? `${row.value}: ${row.hint}` : row.value}
			>
				{row.value}{#if row.hint}<span class="sr-only">: {row.hint}</span>{/if}
			</dd>
		{/each}
	</dl>
</DropdownMenu.Group>
