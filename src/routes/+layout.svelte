<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { ModeWatcher } from 'mode-watcher';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import { onMount } from 'svelte';
	import { registerServiceWorker } from '$lib/pwa-update.js';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	// The service worker only exists in production builds (PWA devOptions are off).
	onMount(() => {
		if (import.meta.env.PROD) void registerServiceWorker();
	});
</script>

<svelte:head>
	<title>Chatty</title>
	<link rel="icon" href={favicon} />
	<meta name="mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
	<link rel="apple-touch-icon" href="/pwa-192x192.png" />
</svelte:head>
<!-- Browser/PWA bar colours: --background in each mode (layout.css). -->
<ModeWatcher
	defaultMode={data.theme}
	disableHeadScriptInjection
	themeColors={{ light: '#f9f8f7', dark: '#0e0d0c' }}
/>
<!-- The installed desktop app has no title bar (window controls overlay, see
     --titlebar-height in layout.css): this strip, where it was, moves the window.
     Zero height everywhere else. -->
<div
	class="fixed inset-x-0 top-0 z-50 h-(--titlebar-height) app-region-drag"
	aria-hidden="true"
></div>
{@render children()}
<Toaster />
