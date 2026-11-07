<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import BellIcon from '@lucide/svelte/icons/bell';
	import BlocksIcon from '@lucide/svelte/icons/blocks';
	import BoxesIcon from '@lucide/svelte/icons/boxes';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import RouteIcon from '@lucide/svelte/icons/route';
	import ServerIcon from '@lucide/svelte/icons/server';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	const sections = [
		{
			href: '/settings/account',
			label: 'Account',
			icon: UserRoundIcon,
			adminOnly: false,
			group: 'You'
		},
		{
			href: '/settings/conversation',
			label: 'Conversation',
			icon: MessageCircleIcon,
			adminOnly: false,
			group: 'You'
		},
		{
			href: '/settings/notifications',
			label: 'Notifications',
			icon: BellIcon,
			adminOnly: false,
			group: 'You'
		},
		{ href: '/settings/memory', label: 'Memory', icon: BrainIcon, adminOnly: false, group: 'You' },
		{
			href: '/settings/providers',
			label: 'Providers',
			icon: PlugIcon,
			adminOnly: true,
			group: 'Models'
		},
		{
			href: '/settings/models',
			label: 'Models',
			icon: BoxesIcon,
			adminOnly: true,
			group: 'Models'
		},
		{
			href: '/settings/mappings',
			label: 'Mappings',
			icon: RouteIcon,
			adminOnly: true,
			group: 'Models'
		},
		{
			href: '/settings/defaults',
			label: 'Defaults',
			icon: SlidersHorizontalIcon,
			adminOnly: true,
			group: 'Models'
		},
		{
			href: '/settings/environments',
			label: 'Coding environments',
			icon: ServerIcon,
			adminOnly: false,
			group: 'Integrations'
		},
		{
			href: '/settings/mcp',
			label: 'MCP servers',
			icon: BlocksIcon,
			adminOnly: true,
			group: 'Integrations'
		},
		{
			href: '/settings/api',
			label: 'API',
			icon: KeyRoundIcon,
			adminOnly: false,
			group: 'Integrations'
		}
	] as const;

	const isAdmin = $derived(data.user.role === 'admin');
	const visibleSections = $derived(sections.filter((section) => !section.adminOnly || isAdmin));
	const visibleGroups = $derived(
		(['You', 'Models', 'Integrations'] as const)
			.map((name) => ({ name, items: visibleSections.filter((section) => section.group === name) }))
			.filter((group) => group.items.length > 0)
	);
	const isActive = (href: string) => page.url.pathname.startsWith(href);
</script>

<div class="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:gap-6 md:p-6">
		<!-- Left padding on phones clears the floating "open sidebar" button. -->
		<h1 class="flex items-center gap-2 pl-10 text-xl font-semibold md:pl-0">
			<SettingsIcon class="size-5" />
			Settings
		</h1>

		<!-- Phones and tablets: one scrollable row of tabs, like the Usage page. -->
		<nav
			class="-mx-4 flex [scrollbar-width:none] gap-1 overflow-x-auto overflow-y-hidden border-b px-4 md:hidden"
			aria-label="Settings sections"
		>
			{#each visibleSections as section (section.href)}
				<a
					href={resolve(section.href)}
					aria-current={isActive(section.href) ? 'page' : undefined}
					class="shrink-0 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors {isActive(
						section.href
					)
						? 'border-foreground font-medium text-foreground'
						: 'border-transparent text-muted-foreground hover:text-foreground'}"
				>
					{section.label}
				</a>
			{/each}
		</nav>

		<div class="flex gap-8">
			<nav
				class="sticky top-6 hidden w-52 shrink-0 flex-col gap-4 self-start md:flex"
				aria-label="Settings sections"
			>
				{#each visibleGroups as group (group.name)}
					<div class="flex flex-col gap-0.5">
						<h2 class="px-3 pb-1 text-xs font-medium text-muted-foreground">{group.name}</h2>
						{#each group.items as section (section.href)}
							<a
								href={resolve(section.href)}
								aria-current={isActive(section.href) ? 'page' : undefined}
								class="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition-colors {isActive(
									section.href
								)
									? 'bg-accent font-medium text-accent-foreground'
									: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
							>
								<section.icon class="size-4 shrink-0" aria-hidden="true" />
								{section.label}
							</a>
						{/each}
					</div>
				{/each}
			</nav>
			<main class="flex min-w-0 flex-1 flex-col gap-6">
				{@render children()}
			</main>
		</div>
	</div>
</div>
