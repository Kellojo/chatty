<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	const sections = [
		{ href: '/settings/account', label: 'Account', adminOnly: false, group: 'General' },
		{ href: '/settings/providers', label: 'Providers', adminOnly: true, group: 'Models' },
		{ href: '/settings/models', label: 'Models', adminOnly: true, group: 'Models' },
		{ href: '/settings/mappings', label: 'Mappings', adminOnly: true, group: 'Models' },
		{ href: '/settings/defaults', label: 'Model Defaults', adminOnly: true, group: 'Models' },
		{ href: '/settings/api', label: 'API', adminOnly: false, group: 'Other' },
		{ href: '/settings/memory', label: 'Memory', adminOnly: false, group: 'Other' },
		{ href: '/settings/mcp', label: 'MCP', adminOnly: true, group: 'Other' },
		{ href: '/settings/search', label: 'Search', adminOnly: true, group: 'Other' }
	] as const;

	const isAdmin = $derived(data.user.role === 'admin');
	const visibleSections = $derived(sections.filter((section) => !section.adminOnly || isAdmin));
	const visibleGroups = $derived(
		(['General', 'Models', 'Other'] as const)
			.map((name) => ({ name, items: visibleSections.filter((section) => section.group === name) }))
			.filter((group) => group.items.length > 0)
	);
</script>

<div class="h-full [scrollbar-gutter:stable] overflow-y-auto">
	<div class="mx-auto flex w-full max-w-7xl gap-8 p-6">
		<nav class="sticky top-6 flex w-40 shrink-0 flex-col gap-1 self-start">
			<h1 class="mb-2 flex items-center gap-2 px-3 text-lg font-semibold">
				<SettingsIcon class="size-5" />
				Settings
			</h1>
			{#each visibleGroups as group (group.name)}
				{#if group.name}
					<h2
						class="mt-2 border-b px-2 pt-3 pb-1 text-xs font-semibold tracking-wider text-foreground uppercase"
					>
						{group.name}
					</h2>
				{/if}
				{#each group.items as section (section.href)}
					<a
						href={resolve(section.href)}
						class="rounded-md px-3 py-1.5 text-sm {page.url.pathname.startsWith(section.href)
							? 'bg-accent font-medium text-accent-foreground'
							: 'text-muted-foreground hover:bg-accent/50'}"
					>
						{section.label}
					</a>
				{/each}
			{/each}
		</nav>
		<main class="min-w-0 flex-1">
			{@render children()}
		</main>
	</div>
</div>
