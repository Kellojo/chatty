<script lang="ts">
	import { onMount } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import Sidebar from '$lib/components/app/Sidebar.svelte';
	import PanelLeftIcon from '@lucide/svelte/icons/panel-left';
	import { startServerEvents } from '$lib/state/events.svelte.js';
	import { setSidebarState } from '$lib/components/app/sidebar-state.svelte.js';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	const isDesktop = new MediaQuery('(min-width: 768px)');

	let sidebarOpen = $state(data.sidebarOpen);
	let mobileOpen = $state(false);

	setSidebarState({
		get open() {
			return sidebarOpen;
		},
		get isMobile() {
			return !isDesktop.current;
		},
		get mobileOpen() {
			return mobileOpen;
		}
	});

	function setSidebarOpen(open: boolean) {
		sidebarOpen = open;
		void fetch('/api/user/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ sidebarOpen: open })
		});
	}

	function toggleSidebar() {
		if (isDesktop.current) {
			setSidebarOpen(!sidebarOpen);
		} else {
			mobileOpen = !mobileOpen;
		}
	}

	onMount(() => startServerEvents());
</script>

<div class="flex h-screen overflow-hidden">
	<!-- Desktop sidebar: in-flow, collapsible -->
	{#if isDesktop.current}
		<div
			class="h-full shrink-0 overflow-hidden transition-[width] duration-200"
			style:width={sidebarOpen ? '288px' : '0px'}
		>
			<Sidebar
				user={data.user}
				conversations={data.conversations}
				hasMore={data.hasMoreConversations}
				unreadIds={data.unreadIds}
				onclose={() => setSidebarOpen(false)}
			/>
		</div>
	{/if}

	<!-- Mobile: sliding container with sidebar and content side by side -->
	{#if !isDesktop.current}
		<div
			class="fixed inset-y-0 left-0 flex w-[200%] transition-transform duration-300 ease-out md:hidden"
			style:transform={mobileOpen ? 'translateX(0)' : 'translateX(-50%)'}
		>
			<div class="h-full w-1/2 shrink-0 [&>aside]:w-full">
				<Sidebar
					user={data.user}
					conversations={data.conversations}
					hasMore={data.hasMoreConversations}
					unreadIds={data.unreadIds}
					onclose={() => (mobileOpen = false)}
				/>
			</div>
			<div class="h-full w-1/2 shrink-0">
				<main class="relative flex h-full flex-col">
					{@render children()}
				</main>
			</div>
		</div>
	{/if}

	<!-- Desktop main content -->
	{#if isDesktop.current}
		<main class="relative flex min-w-0 flex-1 flex-col">
			{@render children()}
		</main>
	{/if}

	{#if isDesktop.current ? !sidebarOpen : !mobileOpen}
		<button
			class="absolute top-2 left-2 z-20 rounded-lg bg-muted p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			onclick={toggleSidebar}
			aria-label="Open sidebar"
		>
			<PanelLeftIcon class="size-4" />
		</button>
	{/if}
</div>
