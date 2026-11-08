<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import MessageSquarePlusIcon from '@lucide/svelte/icons/message-square-plus';
	import LockIcon from '@lucide/svelte/icons/lock';
	import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
	import SearchXIcon from '@lucide/svelte/icons/search-x';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import EmptyState from '$lib/components/app/EmptyState.svelte';
	import { Button } from '$lib/components/ui/button/index.js';

	// Replaces SvelteKit's bare default error page, which offers no way back (a dead
	// end on phones and in the installed app, where there is no browser chrome).
	const specific404 = $derived(
		page.status === 404 && page.error?.message && page.error.message !== 'Not Found'
			? page.error.message
			: null
	);
	const copy = $derived(
		page.status === 404
			? {
					icon: SearchXIcon,
					// "Agent not found" says more than "Page not found"; it becomes the title.
					title: specific404 ?? 'Page not found',
					fallback: specific404
						? 'It may have been deleted, or the link is incomplete.'
						: "This page doesn't exist."
				}
			: page.status === 401 || page.status === 403
				? {
						icon: LockIcon,
						title: 'No access',
						fallback: "You don't have permission to view this page."
					}
				: {
						icon: TriangleAlertIcon,
						title: 'Something went wrong',
						fallback: 'An unexpected error occurred. Try again in a moment.'
					}
	);
	// SvelteKit's generic "Internal Error" / "Not Found" messages add nothing to the title,
	// and "Admin required" reads better as what to do about it.
	const message = $derived(
		specific404
			? copy.fallback
			: page.error?.message === 'Admin required'
				? 'Only admins can open this page. Ask an admin to change it for you.'
				: page.error?.message && !['Internal Error', 'Not Found'].includes(page.error.message)
					? page.error.message
					: copy.fallback
	);
	// A missing agent, skill or request, or a blocked settings section: offer the way back to
	// its list, which is where the user most likely came from.
	const SECTIONS = [
		{ prefix: '/settings', href: '/settings/account', label: 'Back to settings' },
		{ prefix: '/agents', href: '/agents', label: 'Back to agents' },
		{ prefix: '/skills', href: '/skills', label: 'Back to skills' },
		{ prefix: '/usage', href: '/usage', label: 'Back to usage' }
	] as const;
	const back = $derived(SECTIONS.find((s) => page.url.pathname.startsWith(s.prefix)));
</script>

<svelte:head><title>{copy.title} · Chatty</title></svelte:head>

<div class="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-4">
	<EmptyState icon={copy.icon} title={copy.title} description={message}>
		{#if page.status >= 500}
			<Button variant="outline" onclick={() => location.reload()}>
				<RotateCwIcon />
				Try again
			</Button>
		{/if}
		{#if back}
			<Button href={resolve(back.href)}>
				<ArrowLeftIcon />
				{back.label}
			</Button>
		{/if}
		<Button variant={back ? 'outline' : 'default'} href={resolve('/')}>
			<MessageSquarePlusIcon />
			New chat
		</Button>
	</EmptyState>
	<p class="text-xs text-muted-foreground tabular-nums">Error {page.status}</p>
</div>
