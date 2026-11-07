<script lang="ts">
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
	import FolderXIcon from '@lucide/svelte/icons/folder-x';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ServerIcon from '@lucide/svelte/icons/server';
	import HandIcon from '@lucide/svelte/icons/hand';
	import PencilLineIcon from '@lucide/svelte/icons/pencil-line';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import GithubIcon from './GithubIcon.svelte';
	import NewProjectDialog from './NewProjectDialog.svelte';
	import {
		AUTONOMY_OPTIONS,
		LOCAL_CHECKOUT,
		type CodingTaskState
	} from '$lib/state/coding-task.svelte.js';
	import type { CodingAutonomy } from '$lib/coding-environments.js';

	let {
		state: task,
		disabled = false,
		oncreated
	}: {
		state: CodingTaskState;
		disabled?: boolean;
		/** Called once a newly created or cloned project is selected. */
		oncreated?: () => void;
	} = $props();

	// Select values for the project menu's actions. T3 project ids are UUIDs, so
	// these never collide; the getter binding below keeps them from becoming the selection.
	const NEW_PROJECT = ':new';
	const CLONE_PROJECT = ':clone';
	const SEARCH_THRESHOLD = 6;

	let dialogOpen = $state(false);
	let dialogMode = $state<'empty' | 'clone'>('clone');
	let projectQuery = $state('');
	let branchQuery = $state('');
	const uid = $props.id();
	const projectListboxId = `${uid}-projects`;
	const branchListboxId = `${uid}-branches`;
	let searchEl = $state<HTMLInputElement | null>(null);

	// Filled like the model picker inside the input, so they read as its settings
	// rather than as more suggestion pills (which are outlined).
	const chip =
		'relative h-8 shrink-0 max-w-60 min-w-0 gap-1.5 rounded-full max-sm:before:absolute max-sm:before:inset-x-0 max-sm:before:-inset-y-1.5 border-transparent bg-input/40 px-3 text-sm text-muted-foreground shadow-none hover:bg-input/70 hover:text-foreground data-[state=open]:bg-input/70 data-[state=open]:text-foreground dark:bg-input/30 dark:hover:bg-input/60 max-sm:px-2 max-sm:[&>svg:last-child]:hidden sm:max-w-64 [&>svg]:text-muted-foreground [&>svg:last-child]:size-3.5';

	const AUTONOMY_ICONS: Record<CodingAutonomy, typeof HandIcon> = {
		supervised: HandIcon,
		'auto-edits': PencilLineIcon,
		auto: ZapIcon,
		'full-access': ShieldAlertIcon
	};
	const AutonomyIcon = $derived(AUTONOMY_ICONS[task.autonomy]);
	// Same look as a chip, minus the hover/open affordances (for non-interactive states).
	const staticChip =
		'inline-flex h-8 shrink-0 max-w-60 min-w-0 cursor-default items-center gap-1.5 rounded-full bg-input/40 px-3 text-sm text-muted-foreground dark:bg-input/30 max-sm:px-2 [&>svg]:text-muted-foreground';
	const warnFullAccess = 'text-amber-600 dark:text-amber-400 [&>svg]:text-current!';
	// On the chip only the icon turns amber, so the row doesn't read as an error.
	const warnIconOnly =
		'ring-1 ring-amber-500/40 [&>svg:first-child]:text-amber-600! dark:[&>svg:first-child]:text-amber-400!';

	const filteredProjects = $derived.by(() => {
		const q = projectQuery.trim().toLowerCase();
		const projects = task.options?.projects ?? [];
		return q ? projects.filter((p) => p.title.toLowerCase().includes(q)) : projects;
	});

	const filteredBranches = $derived.by(() => {
		const q = branchQuery.trim().toLowerCase();
		return q ? task.branchList.filter((b) => b.name.toLowerCase().includes(q)) : task.branchList;
	});

	/**
	 * Shortens long branch names, preferring to cut at a `/` or `-` boundary
	 * and keeping the end, which is usually the most specific part
	 * (`feat/t3-coding-environments` → `feat/…environments`).
	 */
	function shortBranch(name: string, max = 18): string {
		if (name.length <= max) return name;
		const slash = name.indexOf('/');
		const head = slash > 0 && slash < max / 2 ? name.slice(0, slash + 1) : '';
		// Longest run of whole trailing segments that fits after the head.
		const parts = name.slice(head.length).split(/(?<=[-/_])/);
		let tail = '';
		for (let i = parts.length - 1; i >= 0; i--) {
			if (head.length + 1 + parts[i].length + tail.length > max) break;
			tail = parts[i] + tail;
		}
		if (tail) return `${head}…${tail}`;
		const last = parts[parts.length - 1];
		if (last.length <= max) return `…${last}`;
		return `${name.slice(0, max - 1)}…`;
	}

	const branchLabel = $derived(
		task.branchValue === LOCAL_CHECKOUT ? 'Project checkout' : task.branchValue || 'Branch'
	);

	function openDialog(mode: 'empty' | 'clone') {
		dialogMode = mode;
		dialogOpen = true;
	}

	function onProjectChange(value: string) {
		projectQuery = '';
		if (value === NEW_PROJECT) return openDialog('empty');
		if (value === CLONE_PROJECT) return openDialog('clone');
		if (value !== task.projectId) void task.selectProject(value);
	}

	// Let typing go into the search box, but keep arrows/Enter/Escape for list navigation.
	function searchKeydown(e: KeyboardEvent) {
		if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(e.key)) e.stopPropagation();
	}
</script>

{#snippet searchBox(
	value: string,
	onchange: (v: string) => void,
	placeholder: string,
	listboxId: string
)}
	<div class="sticky top-0 z-10 border-b bg-popover/95 p-1 backdrop-blur-sm">
		<div class="relative">
			<SearchIcon
				class="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
			/>
			<input
				bind:this={searchEl}
				type="text"
				aria-controls={listboxId}
				{value}
				{placeholder}
				aria-label={placeholder.replace('…', '')}
				class="h-8 w-full rounded-3xl border border-transparent bg-input/50 pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30"
				oninput={(e) => onchange(e.currentTarget.value)}
				onclick={(e) => e.stopPropagation()}
				onkeydown={searchKeydown}
			/>
		</div>
	</div>
{/snippet}

{#snippet environmentPicker()}
	{#if task.environments.length > 1}
		<Select.Root
			type="single"
			value={task.environmentId}
			onValueChange={(v) => void task.selectEnvironment(v)}
		>
			<Select.Trigger
				class={chip}
				{disabled}
				aria-label="Environment: {task.environment?.name ?? 'none'}"
				title="Where the coding agent runs"
			>
				<ServerIcon class="size-4" />
				<span class="truncate text-foreground">{task.environment?.name ?? 'Environment'}</span>
			</Select.Trigger>
			<Select.Content>
				<Select.Group>
					<Select.Label>Run on</Select.Label>
					{#each task.environments as env (env.id)}
						<Select.Item value={env.id}>{env.name}</Select.Item>
					{/each}
				</Select.Group>
			</Select.Content>
		</Select.Root>
	{/if}
{/snippet}

<div class="flex flex-col gap-2">
	{#if task.optionsError}
		{#if task.environments.length > 1}<div>{@render environmentPicker()}</div>{/if}
		<div
			class="flex items-start gap-2 rounded-2xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
			role="alert"
		>
			<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />
			<p class="min-w-0 flex-1">
				Couldn't reach {task.environment?.name ?? 'the coding environment'}.
				<span class="line-clamp-2 text-xs text-destructive/80">{task.optionsError}</span>
			</p>
			<Button
				variant="ghost"
				size="sm"
				class="-my-1 h-7 shrink-0 rounded-full text-destructive hover:text-destructive"
				onclick={() => void task.selectEnvironment(task.environmentId, { refresh: true })}
			>
				<RefreshCwIcon class="size-3.5" />
				Retry
			</Button>
		</div>
	{:else if task.options && task.options.projects.length === 0}
		{#if task.environments.length > 1}<div>{@render environmentPicker()}</div>{/if}
		<div
			class="flex flex-col items-center gap-3 rounded-2xl border border-dashed px-4 py-4 text-center"
		>
			<p class="text-sm text-muted-foreground">
				No projects on {task.environment?.name ?? 'this environment'} yet.
			</p>
			<div class="flex flex-wrap justify-center gap-2">
				<Button size="sm" class="rounded-full" {disabled} onclick={() => openDialog('clone')}>
					<GithubIcon class="size-4" />
					Clone repository
				</Button>
				<Button
					variant="outline"
					size="sm"
					class="rounded-full"
					{disabled}
					onclick={() => openDialog('empty')}
				>
					<FolderPlusIcon class="size-4" />
					New empty project
				</Button>
			</div>
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Coding task options">
			{@render environmentPicker()}

			{#if task.optionsLoading || !task.options}
				<div class="contents">
					<span class="sr-only" role="status"
						>Connecting to {task.environment?.name ?? 'environment'}…</span
					>
					<!-- Placeholder chips at their usual size so nothing shifts once options load. -->
					<span class="{staticChip} w-24 animate-pulse" aria-hidden="true"></span>
					<span class="{staticChip} w-40 animate-pulse" aria-hidden="true"></span>
					<span class="{staticChip} w-28 animate-pulse sm:ml-auto" aria-hidden="true"></span>
				</div>
			{:else}
				<Select.Root
					type="single"
					bind:value={() => task.projectId, onProjectChange}
					onOpenChange={(open) => {
						projectQuery = '';
						// After bits-ui moves focus into the list, so typing filters instead of jumping.
						if (open) requestAnimationFrame(() => searchEl?.focus());
					}}
				>
					<Select.Trigger
						class={chip}
						{disabled}
						aria-label="Project: {task.project?.title ?? 'none'}"
						title="Switch or add a project"
					>
						<FolderIcon class="size-4" />
						<span class="truncate text-foreground">
							{task.project?.title ?? 'Project'}
						</span>
					</Select.Trigger>
					<Select.Content
						side="bottom"
						align="start"
						avoidCollisions={false}
						id={projectListboxId}
						class="max-h-[min(26rem,var(--bits-select-content-available-height))] min-w-64"
					>
						{#if task.options.projects.length > SEARCH_THRESHOLD}
							{@render searchBox(
								projectQuery,
								(v) => (projectQuery = v),
								'Search projects…',
								projectListboxId
							)}
						{/if}
						<Select.Group>
							<Select.Label>Projects</Select.Label>
							{#each filteredProjects as p (p.id)}
								<Select.Item value={p.id} label={p.title}>
									<span class="truncate">{p.title}</span>
									{#if !p.isGitRepo}
										<span class="text-xs text-muted-foreground">no git</span>
									{/if}
								</Select.Item>
							{:else}
								<div class="px-3 py-4 text-center text-sm text-muted-foreground">
									No projects match “{projectQuery}”.
								</div>
							{/each}
						</Select.Group>
						<!-- Pinned so the actions stay reachable when the list scrolls. -->
						<div class="sticky bottom-0 -mb-1 bg-popover pb-1">
							<Select.Separator />
							<Select.Group>
								<Select.Label>Add a project</Select.Label>
								<Select.Item value={CLONE_PROJECT} label="Clone repository">
									<GithubIcon class="size-4 text-muted-foreground" />
									Clone repository…
								</Select.Item>
								<Select.Item value={NEW_PROJECT} label="New empty project">
									<FolderPlusIcon class="size-4 text-muted-foreground" />
									New empty project…
								</Select.Item>
							</Select.Group>
						</div>
					</Select.Content>
				</Select.Root>

				{#if task.project}
					{#if task.branchesLoading}
						<span class="{staticChip} opacity-70" role="status">
							<LoaderCircleIcon class="size-4 animate-spin" />
							<span class="truncate">Loading branches…</span>
						</span>
					{:else if task.isRepo}
						<Select.Root
							type="single"
							value={task.branchValue}
							onValueChange={(v) => task.setBranch(v)}
							onOpenChange={(open) => {
								branchQuery = '';
								if (open) requestAnimationFrame(() => searchEl?.focus());
							}}
						>
							<Select.Trigger
								class={[chip, 'sm:max-w-80']}
								{disabled}
								aria-label={task.branchValue === LOCAL_CHECKOUT
									? 'Project checkout, no worktree'
									: `from ${task.branchValue}, in a new worktree`}
								title={task.branchValue === LOCAL_CHECKOUT
									? 'Works directly in the project checkout'
									: `Works in a new worktree branched from ${task.branchValue}`}
							>
								<GitBranchIcon class="size-4 max-sm:hidden" />
								{#if task.branchValue !== LOCAL_CHECKOUT}
									<span class="max-sm:hidden">from</span>
								{/if}
								<!-- Shorter on phones so all chips fit on one row. -->
								<span class="truncate text-foreground max-sm:hidden">{branchLabel}</span>
								<span class="truncate text-foreground sm:hidden"
									>{shortBranch(branchLabel, 12)}</span
								>
							</Select.Trigger>
							<Select.Content
								side="bottom"
								align="start"
								avoidCollisions={false}
								id={branchListboxId}
								class="max-h-[min(24rem,var(--bits-select-content-available-height))] min-w-72"
							>
								{#if task.branchList.length > SEARCH_THRESHOLD}
									{@render searchBox(
										branchQuery,
										(v) => (branchQuery = v),
										'Search branches…',
										branchListboxId
									)}
								{/if}
								<Select.Group>
									<Select.Label>New worktree from</Select.Label>
									{#each filteredBranches as b (b.name)}
										<Select.Item value={b.name} label={b.name}>
											<span class="min-w-0 flex-1 truncate">{b.name}</span>
											{#if b.isDefault}
												<span class="shrink-0 pr-6 text-xs text-muted-foreground">default</span>
											{:else if b.current}
												<span class="shrink-0 pr-6 text-xs text-muted-foreground">checked out</span>
											{/if}
										</Select.Item>
									{:else}
										<div class="px-3 py-4 text-center text-sm text-muted-foreground">
											No branches match “{branchQuery}”.
										</div>
									{/each}
								</Select.Group>
								<Select.Separator />
								<Select.Group>
									<Select.Label>Without a worktree</Select.Label>
									<Select.Item value={LOCAL_CHECKOUT} label="Project checkout">
										<span class="flex flex-col">
											<span>Project checkout</span>
											<span class="text-xs text-muted-foreground"
												>Edits the project folder in place</span
											>
										</span>
									</Select.Item>
								</Select.Group>
							</Select.Content>
						</Select.Root>
					{:else}
						<span
							class={staticChip}
							title="This project isn't a git repository, so the agent edits its folder directly"
						>
							<FolderXIcon class="size-4" />
							<span class="truncate">No git · edits in place</span>
						</span>
					{/if}
				{/if}

				<Select.Root
					type="single"
					value={task.autonomy}
					onValueChange={(v) => task.setAutonomy(v as CodingAutonomy)}
				>
					<Select.Trigger
						class={[chip, 'sm:ml-auto', task.autonomy === 'full-access' && warnIconOnly]}
						{disabled}
						aria-label="Permissions: {task.autonomyOption.label}"
						title={task.autonomy === task.defaultAutonomy
							? `${task.autonomyOption.hint} · default on ${task.environment?.name ?? 'the environment'}`
							: task.autonomyOption.hint}
					>
						<AutonomyIcon class="size-4" />
						<span class="text-muted-foreground max-sm:hidden">Permissions:</span>
						<span class="truncate text-foreground max-sm:hidden">{task.autonomyOption.label}</span>
						<span class="text-foreground sm:hidden">{task.autonomyOption.short}</span>
					</Select.Trigger>
					<Select.Content
						side="bottom"
						align="end"
						avoidCollisions={false}
						class="w-[min(20rem,calc(100vw-2rem))]"
					>
						<Select.Group>
							<Select.Label>Permissions</Select.Label>
							{#each AUTONOMY_OPTIONS as a (a.value)}
								{@const Icon = AUTONOMY_ICONS[a.value]}
								<Select.Item
									value={a.value}
									label={a.label}
									class={a.value === 'full-access' ? warnFullAccess : undefined}
								>
									<Icon
										class={[
											'size-4 self-start',
											a.value === 'full-access' ? 'text-current' : 'text-muted-foreground'
										]}
									/>
									<span class="flex flex-col whitespace-normal">
										<span class="flex items-center gap-2">
											{a.label}
											{#if a.value === task.defaultAutonomy}
												<span
													class="rounded border border-border px-1 text-[11px] font-medium text-muted-foreground"
													title="Default set on {task.environment?.name ?? 'the environment'}"
													>Default</span
												>
											{/if}
										</span>
										<span class="text-xs text-muted-foreground">{a.hint}</span>
									</span>
								</Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			{/if}
		</div>
	{/if}
</div>

{#if task.environmentId}
	<NewProjectDialog
		bind:open={dialogOpen}
		bind:mode={dialogMode}
		environmentId={task.environmentId}
		environmentName={task.environment?.name ?? 'the environment'}
		oncreated={async (projectId) => {
			await task.reloadAndSelect(projectId);
			oncreated?.();
		}}
	/>
{/if}
