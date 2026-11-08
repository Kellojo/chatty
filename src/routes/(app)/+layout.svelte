<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { FavoriteModels, setFavoriteModels } from '$lib/state/favorite-models.svelte.js';
	import { MediaQuery } from 'svelte/reactivity';
	import Sidebar from '$lib/components/app/Sidebar.svelte';
	import AttentionNotifier from '$lib/components/app/AttentionNotifier.svelte';
	import PanelLeftIcon from '@lucide/svelte/icons/panel-left';
	import { startServerEvents } from '$lib/state/events.svelte.js';
	import { startMessageQueueRunner } from '$lib/state/message-queue-runner.js';
	import { setSidebarState } from '$lib/components/app/sidebar-state.svelte.js';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	const isDesktop = new MediaQuery('(min-width: 768px)');

	setFavoriteModels(new FavoriteModels(untrack(() => data.settings.favoriteModels)));

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

	onMount(() => {
		const stopEvents = startServerEvents();
		const stopQueueRunner = startMessageQueueRunner();
		return () => {
			stopQueueRunner();
			stopEvents();
		};
	});
</script>

<AttentionNotifier
	conversations={data.conversations}
	unreadIds={data.unreadIds}
	triggers={data.settings.notificationTriggers}
/>

<!--
	One persistent structure for both breakpoints, switched with CSS (md:) so the
	page (and e.g. a chat draft) survives crossing 768px and SSR matches either.
	Mobile: a 200%-wide sliding container with sidebar and content side by side.
	Desktop: the wrappers dissolve (display: contents) into an in-flow,
	collapsible sidebar next to a flexible main.
-->
<div class="flex h-screen overflow-hidden">
	<div
		class="fixed inset-y-0 left-0 flex w-[200%] transition-transform duration-300 ease-out md:contents"
		style:transform={mobileOpen ? 'translateX(0)' : 'translateX(-50%)'}
	>
		<div
			class="h-full w-1/2 shrink-0 md:w-(--sidebar-width) md:overflow-hidden md:transition-[width] md:duration-200 max-md:[&>aside]:w-full"
			style:--sidebar-width={sidebarOpen ? '288px' : '0px'}
		>
			<Sidebar
				user={data.user}
				conversations={data.conversations}
				hasMore={data.hasMoreConversations}
				unreadIds={data.unreadIds}
				settledCount={data.settledCount}
				autoSettleDays={data.autoSettleDays}
				onclose={() => (isDesktop.current ? setSidebarOpen(false) : (mobileOpen = false))}
			/>
		</div>
		<div class="h-full w-1/2 shrink-0 md:contents">
			<main class="relative flex h-full min-w-0 flex-col md:flex-1">
				{@render children()}
			</main>
		</div>
	</div>

	<button
		class={[
			'fixed top-[calc(0.5rem+env(safe-area-inset-top))] left-[calc(0.5rem+env(safe-area-inset-left))] z-20 rounded-lg bg-muted p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
			mobileOpen && 'max-md:hidden',
			sidebarOpen && 'md:hidden'
		]}
		onclick={toggleSidebar}
		aria-label="Open sidebar"
	>
		<PanelLeftIcon class="size-4" />
	</button>
</div>
