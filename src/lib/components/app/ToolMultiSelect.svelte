<script lang="ts">
	import SearchIcon from '@lucide/svelte/icons/search';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import type { ToolInfo } from '$lib/types.js';

	let {
		tools,
		value = $bindable([]),
		disabled = false,
		placeholder = 'Select tools',
		id
	}: {
		tools: ToolInfo[];
		value: string[];
		disabled?: boolean;
		placeholder?: string;
		id?: string;
	} = $props();

	let query = $state('');

	const known = $derived(new Set(tools.map((t) => t.name)));

	const filteredGroups = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const groups: { server: string; tools: ToolInfo[] }[] = [];
		for (const tool of tools) {
			if (
				q &&
				!tool.name.toLowerCase().includes(q) &&
				!tool.server.toLowerCase().includes(q) &&
				!tool.description.toLowerCase().includes(q)
			) {
				continue;
			}
			const group = groups.find((g) => g.server === tool.server);
			if (group) group.tools.push(tool);
			else groups.push({ server: tool.server, tools: [tool] });
		}
		return groups;
	});

	// Selected names that aren't provided by any currently available server
	// (e.g. a disabled MCP server, or a skill imported from elsewhere).
	const unknownSelected = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return value.filter((n) => !known.has(n) && (!q || n.toLowerCase().includes(q)));
	});

	const customCandidate = $derived.by(() => {
		const q = query.trim();
		if (!q || known.has(q) || value.includes(q)) return null;
		return q;
	});

	const isEmpty = $derived(
		filteredGroups.length === 0 && unknownSelected.length === 0 && !customCandidate
	);

	function remove(name: string) {
		value = value.filter((n) => n !== name);
	}

	function addCustom() {
		if (!customCandidate) return;
		value = [...value, customCandidate];
		query = '';
	}
</script>

<div class="flex flex-col gap-2">
	<Select.Root
		type="multiple"
		bind:value
		onOpenChange={(open) => {
			if (!open) query = '';
		}}
	>
		<Select.Trigger {id} class="w-full" {disabled}>
			<span class="min-w-0 flex-1 truncate text-left text-muted-foreground">
				{value.length === 0
					? placeholder
					: `${value.length} tool${value.length === 1 ? '' : 's'} selected`}
			</span>
		</Select.Trigger>
		<Select.Content
			class="h-[min(24rem,var(--bits-select-content-available-height))] w-(--bits-select-anchor-width) min-w-72"
		>
			<div class="sticky top-0 z-10 border-b bg-popover/95 p-1 backdrop-blur-sm">
				<div class="relative">
					<SearchIcon
						class="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<input
						type="text"
						bind:value={query}
						placeholder="Search tools…"
						class="h-8 w-full rounded-3xl border border-transparent bg-input/50 pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30"
						onclick={(e) => e.stopPropagation()}
						onkeydown={(e) => {
							e.stopPropagation();
							if (e.key === 'Enter') {
								e.preventDefault();
								addCustom();
							}
						}}
					/>
				</div>
			</div>
			{#if customCandidate}
				<button
					type="button"
					class="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm hover:bg-accent"
					onclick={addCustom}
				>
					<PlusIcon class="size-4 shrink-0" />
					<span class="truncate">Add "<span class="font-mono">{customCandidate}</span>"</span>
				</button>
			{/if}
			{#if unknownSelected.length > 0}
				<Select.Group>
					<Select.Label>Not currently available</Select.Label>
					{#each unknownSelected as name (name)}
						<Select.Item value={name} label={name}>
							<span class="truncate font-mono">{name}</span>
						</Select.Item>
					{/each}
				</Select.Group>
			{/if}
			{#each filteredGroups as group (group.server)}
				<Select.Group>
					<Select.Label>{group.server || 'unknown'}</Select.Label>
					{#each group.tools as tool (tool.name)}
						<Select.Item value={tool.name} label={tool.name}>
							<span class="flex min-w-0 flex-col">
								<span class="truncate font-mono">{tool.name}</span>
								{#if tool.description}
									<span class="truncate text-xs font-normal text-muted-foreground">
										{tool.description}
									</span>
								{/if}
							</span>
						</Select.Item>
					{/each}
				</Select.Group>
			{/each}
			{#if isEmpty}
				<div class="px-3 py-6 text-center text-sm text-muted-foreground">No tools found.</div>
			{/if}
		</Select.Content>
	</Select.Root>

	{#if value.length > 0}
		<div class="flex flex-wrap gap-1.5">
			{#each value as name (name)}
				<Badge variant={known.has(name) ? 'secondary' : 'outline'} class="font-mono">
					{name}
					{#if !disabled}
						<button
							type="button"
							class="-mr-1 rounded-full hover:text-foreground"
							aria-label={`Remove ${name}`}
							onclick={() => remove(name)}
						>
							<XIcon class="size-3" />
						</button>
					{/if}
				</Badge>
			{/each}
		</div>
	{/if}
</div>
