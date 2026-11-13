<script lang="ts">
	import SearchIcon from '@lucide/svelte/icons/search';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import XIcon from '@lucide/svelte/icons/x';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { Button } from '$lib/components/ui/button/index.js';
	import ToolIcon from '$lib/components/ai/tool-call-card/ToolIcon.svelte';
	import { untrack } from 'svelte';
	import { describeTool, serverLabel, type ToolKind } from '$lib/tool-meta.js';
	import type { ToolInfo } from '$lib/types.js';

	let {
		tools,
		value = $bindable([]),
		disabled = false,
		emptyWarning = 'No tools allowed. The agent can only reply with text.'
	}: {
		tools: ToolInfo[];
		/** Allowed tool names. */
		value: string[];
		disabled?: boolean;
		/** Shown when nothing is allowed. */
		emptyWarning?: string;
	} = $props();

	interface Entry extends ToolInfo {
		label: string;
		kind: ToolKind;
		/** Short warning for tools that change or delete things. */
		risk: 'Deletes' | 'Changes data' | null;
	}

	// A best guess from the name, since servers don't declare side effects.
	const DELETES = /(^|_)(delete|remove|rm|drop|destroy)(_|$)/i;
	const CHANGES =
		/(^|_)(create|update|write|edit|set|add|save|send|post|put|patch|mkdir|move|rename|import|assign|mark|curl)(_|$)/i;
	function riskOf(name: string, kind: ToolKind): Entry['risk'] {
		if (DELETES.test(name)) return 'Deletes';
		if (kind === 'edit' || kind === 'command' || CHANGES.test(name)) return 'Changes data';
		return null;
	}

	let query = $state('');
	// Open/closed per group once the user toggles it. Until then short lists show
	// every group, and long ones only the groups that already have allowed tools.
	let openOverride = $state<Record<string, boolean>>({});
	const initiallyOpen = untrack(() => {
		const servers = tools
			.filter((t) => tools.length <= 12 || value.includes(t.name))
			.map((t) => t.server);
		return new Set(servers);
	});
	const isOpen = (server: string) => openOverride[server] ?? initiallyOpen.has(server);

	const selected = $derived(new Set(value));
	const known = $derived(new Set(tools.map((t) => t.name)));

	const entries = $derived(
		tools.map((tool): Entry => {
			const { label, kind } = describeTool(tool.name, {});
			return { ...tool, label, kind, risk: riskOf(tool.name, kind) };
		})
	);

	const groups = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const result: {
			server: string;
			builtin: boolean;
			tools: Entry[];
			total: number;
			allowed: number;
			risk: Entry['risk'];
		}[] = [];
		for (const entry of entries) {
			let group = result.find((g) => g.server === entry.server);
			if (!group) {
				group = {
					server: entry.server,
					builtin: entry.builtin === true,
					tools: [],
					total: 0,
					allowed: 0,
					risk: null
				};
				result.push(group);
			}
			group.total++;
			if (entry.risk === 'Deletes' || (entry.risk && !group.risk)) group.risk = entry.risk;
			if (selected.has(entry.name)) group.allowed++;
			const matches =
				!q ||
				entry.name.toLowerCase().includes(q) ||
				entry.label.toLowerCase().includes(q) ||
				entry.server.toLowerCase().includes(q) ||
				serverLabel(entry.server).toLowerCase().includes(q) ||
				entry.description.toLowerCase().includes(q);
			if (matches) group.tools.push(entry);
		}
		return result.filter((g) => g.tools.length > 0);
	});

	/**
	 * Servers bundled with Chatty first, then the ones an admin added. Headings
	 * only show when both kinds are present.
	 */
	const sections = $derived(
		[
			{ key: 'builtin', label: 'Built-in', groups: groups.filter((g) => g.builtin) },
			{ key: 'added', label: 'Added servers', groups: groups.filter((g) => !g.builtin) }
		].filter((section) => section.groups.length > 0)
	);
	const showSectionHeadings = $derived(sections.length > 1);

	const visibleNames = $derived(groups.flatMap((g) => g.tools.map((t) => t.name)));
	const searching = $derived(query.trim() !== '');

	// Saved names no available server provides (a disabled or removed MCP server).
	const unavailable = $derived(value.filter((n) => !known.has(n)));
	const allowedCount = $derived(value.length - unavailable.length);

	function set(names: string[], on: boolean) {
		// Keep the saved order stable and append new picks in list order.
		value = on
			? [...value, ...names.filter((n) => !selected.has(n))]
			: value.filter((n) => !names.includes(n));
	}

	function groupState(group: { tools: Entry[] }): 'all' | 'some' | 'none' {
		const on = group.tools.filter((t) => selected.has(t.name)).length;
		return on === 0 ? 'none' : on === group.tools.length ? 'all' : 'some';
	}

	function indeterminate(on: () => boolean) {
		return (el: HTMLInputElement) => {
			el.indeterminate = on();
		};
	}
</script>

{#snippet riskBadge(risk: NonNullable<Entry['risk']>)}
	<span
		class="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] leading-none font-medium {risk ===
		'Deletes'
			? 'bg-destructive/10 text-destructive'
			: 'bg-amber-500/10 text-amber-700 dark:text-amber-400'}">{risk}</span
	>
{/snippet}

<div class="flex flex-col gap-3">
	<div class="flex flex-wrap items-center gap-1">
		<div class="relative min-w-0 flex-1 basis-full sm:basis-auto">
			<SearchIcon
				class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
			/>
			<input
				type="search"
				bind:value={query}
				placeholder="Search tools…"
				aria-label="Search tools"
				class="h-8 w-full rounded-3xl border border-transparent bg-input/50 pl-8 [&::-webkit-search-cancel-button]:hidden {searching
					? 'pr-24'
					: 'pr-3'} text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30"
				onkeydown={(e) => {
					// Enter would otherwise submit nothing useful; Escape clears the filter.
					if (e.key === 'Enter') e.preventDefault();
					if (e.key === 'Escape' && query) {
						e.preventDefault();
						e.stopPropagation();
						query = '';
					}
				}}
			/>
			<div class="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-1">
				<span class="text-xs text-muted-foreground tabular-nums" aria-live="polite">
					{#if searching}{visibleNames.length} found{/if}
				</span>
				{#if searching}
					<button
						type="button"
						class="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
						aria-label="Clear search"
						onclick={() => (query = '')}
					>
						<XIcon class="size-3.5" />
					</button>
				{/if}
			</div>
		</div>
		{#if !disabled}
			<div class="ml-auto flex shrink-0">
				<Button
					variant="ghost"
					size="sm"
					disabled={visibleNames.every((n) => selected.has(n))}
					aria-label={searching ? 'Allow all matching tools' : 'Allow all tools'}
					onclick={() => set(visibleNames, true)}
				>
					{searching ? 'Allow matching' : 'Allow all'}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					disabled={!visibleNames.some((n) => selected.has(n))}
					aria-label={searching ? 'Deselect all matching tools' : 'Deselect all tools'}
					onclick={() => set(visibleNames, false)}
				>
					{searching ? 'Deselect matching' : 'Deselect all'}
				</Button>
			</div>
		{/if}
	</div>

	{#if allowedCount === 0 && !searching}
		<p
			class="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
		>
			<TriangleAlertIcon class="size-4 shrink-0" />
			{emptyWarning}
		</p>
	{/if}

	<div class="flex flex-col gap-2">
		{#each sections as section, i (section.key)}
			{#if showSectionHeadings}
				<h4 class="px-1 text-xs font-medium text-muted-foreground {i > 0 ? 'pt-3' : ''}">
					{section.label}
				</h4>
			{/if}
			{#each section.groups as group (group.server)}
				{@const state = groupState(group)}
				{@const open = searching || isOpen(group.server)}
				<div class="rounded-xl border border-border/60">
					<div class="flex items-center gap-2 px-3 py-2">
						<input
							type="checkbox"
							class="size-4 shrink-0 accent-primary dark:[color-scheme:dark]"
							aria-label={`Allow every ${serverLabel(group.server) || 'other'} tool`}
							checked={state === 'all'}
							{@attach indeterminate(() => state === 'some')}
							{disabled}
							onchange={(e) =>
								set(
									group.tools.map((t) => t.name),
									e.currentTarget.checked
								)}
						/>
						<button
							type="button"
							class="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium"
							aria-expanded={open}
							disabled={searching}
							onclick={() => (openOverride[group.server] = !isOpen(group.server))}
						>
							<span class="truncate">{serverLabel(group.server) || 'Other'}</span>
							<span class="text-xs font-normal text-muted-foreground tabular-nums">
								{group.allowed}/{group.total}
							</span>
							{#if !open && group.risk}
								{@render riskBadge(group.risk)}
							{/if}
							{#if !searching}
								<ChevronRightIcon
									class="ml-auto size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none {open
										? 'rotate-90'
										: ''}"
								/>
							{/if}
						</button>
					</div>
					{#if open}
						<!-- grid-cols-1 (minmax(0,1fr)), not an auto column: long tool names must truncate, not widen the grid -->
						<div class="grid grid-cols-1 gap-0.5 border-t border-border/60 p-1.5 sm:grid-cols-2">
							{#each group.tools as tool (tool.name)}
								<label
									class="flex min-w-0 items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm {disabled
										? ''
										: 'cursor-pointer hover:bg-accent/50'}"
									title={tool.description ? `${tool.name}: ${tool.description}` : tool.name}
								>
									<input
										type="checkbox"
										class="mt-0.5 size-4 shrink-0 accent-primary dark:[color-scheme:dark]"
										checked={selected.has(tool.name)}
										{disabled}
										onchange={(e) => set([tool.name], e.currentTarget.checked)}
									/>
									<span class="min-w-0 flex-1">
										<span class="flex items-center gap-1.5">
											<ToolIcon kind={tool.kind} class="size-3.5 shrink-0 text-muted-foreground" />
											<span class="truncate font-medium">{tool.label}</span>
											{#if tool.risk}
												{@render riskBadge(tool.risk)}
											{/if}
										</span>
										{#if tool.description}
											<span class="block truncate text-xs text-muted-foreground"
												>{tool.description}</span
											>
										{/if}
									</span>
								</label>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		{:else}
			<p class="py-4 text-center text-sm text-muted-foreground">
				{searching ? 'No tools match your search.' : 'No tools available.'}
			</p>
		{/each}
	</div>
	{#if unavailable.length > 0}
		<div class="flex flex-col gap-1.5 rounded-lg border border-dashed px-3 py-2">
			<p class="text-xs">
				<span class="font-medium">
					{unavailable.length} unavailable {unavailable.length === 1 ? 'tool' : 'tools'}
				</span>
				<span class="text-muted-foreground"
					>· the server is off or removed, so {unavailable.length === 1 ? "it's" : "they're"} skipped
					until it's back.</span
				>
			</p>
			<div class="flex flex-wrap gap-1.5">
				{#each unavailable as name (name)}
					<span
						class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-xs"
					>
						{name}
						{#if !disabled}
							<button
								type="button"
								class="-my-1 -mr-1.5 grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
								aria-label={`Remove ${name}`}
								onclick={() => set([name], false)}
							>
								<XIcon class="size-3" />
							</button>
						{/if}
					</span>
				{/each}
			</div>
		</div>
	{/if}
</div>
