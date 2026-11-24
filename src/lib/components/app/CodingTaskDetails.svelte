<script lang="ts">
	import { toast } from 'svelte-sonner';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import {
		NO_PROJECT_TITLE,
		type CodingConversation,
		type CodingModelOption
	} from '$lib/coding-environments.js';
	import {
		autonomyFromRuntimeMode,
		modelSlugLabel,
		runtimeModeLabel
	} from '$lib/coding-task-details.js';
	import { AUTONOMY_OPTIONS } from '$lib/state/coding-task.svelte.js';
	import { loadCodingModels } from '$lib/state/coding-models.js';
	import { resolveBrand, type Brand } from '$lib/provider-brand.js';
	import BotIcon from '@lucide/svelte/icons/bot';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderGit2Icon from '@lucide/svelte/icons/folder-git-2';
	import FolderXIcon from '@lucide/svelte/icons/folder-x';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GitForkIcon from '@lucide/svelte/icons/git-fork';
	import ServerIcon from '@lucide/svelte/icons/server';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import ProviderIcon from './ProviderIcon.svelte';
	import { AUTONOMY_ICONS, FULL_ACCESS_TONE } from './coding-icons.js';

	/** What T3 knows about a coding task, rendered inside the conversation menu. */
	let {
		coding,
		environmentName = null
	}: {
		coding: CodingConversation;
		environmentName?: string | null;
	} = $props();

	const uid = $props.id();

	type Row = {
		label: string;
		value: string;
		icon?: typeof FolderIcon;
		brand?: Brand | null;
		mono?: boolean;
		/** Extra context for the tooltip and screen readers. */
		hint?: string;
		tone?: string;
	};
	type Draft = Omit<Row, 'value'> & { value: string | null | undefined };
	const present = (rows: Draft[]) => rows.filter((row): row is Row => !!row.value);

	// The task stores only the model's slug; its display name comes from the environment.
	let modelOption = $state<CodingModelOption | null>(null);
	$effect(() => {
		const { environmentId, providerInstanceId, model } = coding;
		modelOption = null;
		if (!environmentId) return;
		let stale = false;
		loadCodingModels(environmentId)
			.then((models) => {
				if (stale) return;
				modelOption =
					models.find((m) => m.providerInstanceId === providerInstanceId && m.model === model) ??
					null;
			})
			.catch(() => {}); // Keeps the name derived from the slug.
		return () => {
			stale = true;
		};
	});
	const modelBrand = $derived(
		modelOption
			? resolveBrand(modelOption.provider, modelOption.providerLabel)
			: resolveBrand(coding.model, coding.providerInstanceId)
	);

	const autonomy = $derived(autonomyFromRuntimeMode(coding.runtimeMode));
	const worktree = $derived(coding.workspaceMode === 'worktree');
	const noProject = $derived(coding.projectTitle === NO_PROJECT_TITLE);

	const workspaceRows = $derived(
		present([
			// The task's own branch is the copyable row above; the base only while there is none.
			{
				label: 'Base branch',
				value: coding.branch ? null : coding.baseBranch,
				icon: GitBranchIcon,
				mono: true
			},
			{
				label: 'Project',
				value: coding.projectTitle,
				icon: noProject ? FolderXIcon : FolderIcon,
				hint: noProject ? 'Works in an empty folder of its own' : undefined
			},
			{
				label: 'Checkout',
				value: worktree ? 'Own worktree' : 'Project checkout',
				icon: worktree ? GitForkIcon : FolderGit2Icon,
				hint: worktree
					? 'Works on its own copy of the project'
					: 'Works directly in the project folder'
			},
			{ label: 'Environment', value: environmentName, icon: ServerIcon }
		])
	);

	const agentRows = $derived(
		present([
			{
				label: 'Model',
				value: modelOption?.label ?? modelSlugLabel(coding.model),
				icon: BotIcon,
				brand: modelBrand,
				hint: modelOption ? `${modelOption.providerLabel}, ${coding.model}` : coding.model
			},
			{
				label: 'Permissions',
				value: runtimeModeLabel(coding.runtimeMode),
				icon: autonomy ? AUTONOMY_ICONS[autonomy] : ShieldIcon,
				hint: AUTONOMY_OPTIONS.find((o) => o.value === autonomy)?.hint,
				tone: autonomy === 'full-access' ? FULL_ACCESS_TONE : undefined
			}
		])
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
		// Widen the tail back to the nearest word break, so it keeps at least TAIL characters.
		const cut = Math.max(...['-', '/', '_', '.'].map((c) => branch.lastIndexOf(c, from - 1)));
		const at = cut >= from - 8 ? cut + 1 : from;
		return { head: branch.slice(0, at), tail: branch.slice(at) };
	});

	// The row confirms the copy in place, so the menu stays open long enough to see it.
	let copied = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => () => clearTimeout(copiedTimer));

	async function copyBranch(event: Event) {
		event.preventDefault();
		if (!coding.branch) return;
		try {
			await navigator.clipboard.writeText(coding.branch);
			copied = true;
			clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => (copied = false), 1500);
		} catch {
			toast.error('Failed to copy');
		}
	}

	const caption = 'px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground';
	const icon = 'size-3.5 shrink-0 text-muted-foreground';
</script>

{#snippet rowList(rows: Row[], first: boolean)}
	<dl
		class="grid cursor-default grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 px-3 text-[13px] leading-5 {first
			? 'pt-1'
			: 'pt-[3px]'}"
	>
		{#each rows as row (row.label)}
			<dt class="text-muted-foreground">{row.label}</dt>
			<dd
				class="flex min-w-0 items-center justify-end gap-1.5 {row.tone ?? 'text-foreground'}"
				title={row.hint
					? `${row.value}: ${row.hint}`
					: row.value.length > 24
						? row.value
						: undefined}
			>
				{#if row.brand}
					<ProviderIcon brand={row.brand} decorative class="size-3.5 shrink-0" />
				{:else if row.icon}
					<row.icon class="{icon} {row.tone ? 'text-current' : ''}" aria-hidden="true" />
				{/if}
				<span class="truncate {row.mono ? 'font-mono text-[13.5px]' : ''}">{row.value}</span>
				{#if row.hint}<span class="sr-only">: {row.hint}</span>{/if}
			</dd>
		{/each}
	</dl>
{/snippet}

<DropdownMenu.Group aria-labelledby="{uid}-workspace">
	<DropdownMenu.Label id="{uid}-workspace" class={caption}>Workspace</DropdownMenu.Label>
	{#if coding.branch}
		<!-- The branch is the detail people act on, so it leads and copies on select. -->
		<DropdownMenu.Item
			onSelect={copyBranch}
			class="justify-between gap-4 py-[3px] text-[13px] font-normal"
			title={copied ? 'Copied' : `Copy ${coding.branch}`}
			aria-label={copied ? 'Branch name copied' : `Copy branch name ${coding.branch}`}
		>
			<!-- `!`: the item recolours every child while highlighted; this is still a label.
			     The copy mark shows under the pointer, by the label, so the values keep one right edge. -->
			<span class="flex shrink-0 items-center gap-1.5 text-muted-foreground!">
				Branch
				{#if copied}
					<CheckIcon class="size-3.5 text-emerald-600! dark:text-emerald-400!" />
				{:else}
					<CopyIcon
						class="size-3.5 opacity-0 transition-opacity group-data-highlighted/dropdown-menu-item:text-foreground! group-data-highlighted/dropdown-menu-item:opacity-100 motion-reduce:transition-none"
					/>
				{/if}
			</span>
			<span class="flex min-w-0 items-center gap-1.5">
				<GitBranchIcon class={icon} />
				<span class="flex min-w-0 font-mono text-[13.5px] leading-5 text-foreground">
					<span class="truncate">{branchSplit.head}</span>
					{#if branchSplit.tail}<span class="shrink-0">{branchSplit.tail}</span>{/if}
				</span>
			</span>
		</DropdownMenu.Item>
		<span class="sr-only" aria-live="polite">{copied ? 'Branch name copied' : ''}</span>
	{/if}
	{@render rowList(workspaceRows, !coding.branch)}
</DropdownMenu.Group>

<DropdownMenu.Group aria-labelledby="{uid}-agent" class="pb-3">
	<DropdownMenu.Label id="{uid}-agent" class="{caption} pt-4">Agent</DropdownMenu.Label>
	{@render rowList(agentRows, true)}
</DropdownMenu.Group>
