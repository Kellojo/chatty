<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import { FavoriteModels, setFavoriteModels } from '$lib/state/favorite-models.svelte.js';
	import { MediaQuery } from 'svelte/reactivity';
	import Sidebar from '$lib/components/app/Sidebar.svelte';
	import AttentionNotifier from '$lib/components/app/AttentionNotifier.svelte';
	import OfflineBanner from '$lib/components/app/OfflineBanner.svelte';
	import PanelLeftIcon from '@lucide/svelte/icons/panel-left';
	import { startServerEvents } from '$lib/state/events.svelte.js';
	import { startMessageQueueRunner } from '$lib/state/message-queue-runner.js';
	import { setSidebarState } from '$lib/components/app/sidebar-state.svelte.js';
	import { chatShortcuts, isTypingTarget, matchShortcut } from '$lib/state/shortcuts.js';
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

	// Phones: the floating sidebar button hides while a page scrolls down beneath it
	// and comes back on scroll up. Scrollers that start below it (the chat timeline,
	// under its topbar) never pass under it, so they leave it alone.
	let buttonHidden = $state(false);
	let sidebarButton = $state<HTMLButtonElement>();
	const lastScrollTop = new WeakMap<Element, number>();
	function onAnyScroll(event: Event) {
		const el = event.target;
		if (isDesktop.current || !(el instanceof Element)) return;
		const top = el.scrollTop;
		const last = lastScrollTop.get(el) ?? 0;
		lastScrollTop.set(el, top);
		// offsetTop ignores the slide-away transform, so this is where the button rests.
		const buttonBottom = sidebarButton ? sidebarButton.offsetTop + sidebarButton.offsetHeight : 48;
		if (el.getBoundingClientRect().top >= buttonBottom - 4) return;
		if (top < 48 || top < last - 8) buttonHidden = false;
		else if (top > last + 8) buttonHidden = true;
	}
	afterNavigate(() => (buttonHidden = false));

	// ── keyboard shortcuts (Ctrl/Cmd+K lives in the sidebar's search) ────────
	const OVERLAY = '[role=dialog], [role=alertdialog], [role=menu], [role=listbox], dialog';

	/** Focus is in, or a modal is showing, something that owns its own keys. */
	function inOverlay(target: EventTarget | null): boolean {
		if (target instanceof Element && target.closest(OVERLAY)) return true;
		return document.querySelector('[role=dialog][data-state=open], [role=alertdialog]') !== null;
	}

	function focusComposer(): boolean {
		const textarea = document.querySelector<HTMLTextAreaElement>('main textarea[data-composer]');
		if (!textarea || textarea.disabled) return false;
		textarea.focus();
		const end = textarea.value.length;
		textarea.setSelectionRange(end, end);
		return true;
	}

	async function copyLastReply(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast.success('Copied the last reply');
		} catch {
			toast.error('Failed to copy');
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented) return;
		const action = matchShortcut(event, isTypingTarget(event.target));
		if (!action) return;
		switch (action) {
			case 'escape':
				if (inOverlay(event.target)) return;
				if (chatShortcuts()?.escape()) event.preventDefault();
				return;
			case 'focus-composer':
				if (inOverlay(event.target)) return;
				if (focusComposer()) event.preventDefault();
				return;
			case 'new-chat':
				event.preventDefault();
				void goto(resolve('/')).then(focusComposer);
				return;
			case 'copy-last-reply': {
				const text = chatShortcuts()?.lastReply();
				if (!text) return;
				event.preventDefault();
				void copyLastReply(text);
				return;
			}
		}
	}

	onMount(() => {
		document.addEventListener('scroll', onAnyScroll, { capture: true, passive: true });
		const stopEvents = startServerEvents();
		const stopQueueRunner = startMessageQueueRunner();
		return () => {
			stopQueueRunner();
			stopEvents();
			document.removeEventListener('scroll', onAnyScroll, { capture: true });
		};
	});
</script>

<svelte:window onkeydown={onKeydown} />

<OfflineBanner />

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
			'fixed top-[calc(0.5rem+env(safe-area-inset-top))] left-[calc(0.5rem+env(safe-area-inset-left))] z-20 rounded-lg bg-muted p-2 text-muted-foreground transition-[color,background-color,opacity,translate] duration-200 hover:bg-accent hover:text-foreground max-md:bg-muted/90 max-md:shadow-md max-md:ring-1 max-md:ring-border max-md:backdrop-blur pointer-coarse:p-3',
			buttonHidden && 'max-md:pointer-events-none max-md:-translate-y-16 max-md:opacity-0',
			mobileOpen && 'max-md:hidden',
			sidebarOpen && 'md:hidden'
		]}
		bind:this={sidebarButton}
		onclick={toggleSidebar}
		aria-label="Open sidebar"
	>
		<PanelLeftIcon class="size-4" />
	</button>
</div>
