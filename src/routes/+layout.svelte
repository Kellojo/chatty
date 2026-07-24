<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { ModeWatcher } from 'mode-watcher';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	// registerSW.js only exists in production builds (and dev with PWA devOptions enabled).
	const registerSw = import.meta.env.PROD;
</script>

<svelte:head>
	<title>Chatty</title>
	<link rel="icon" href={favicon} />
	<meta name="theme-color" content="#0a0a0a" />
	<meta name="mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
	<link rel="apple-touch-icon" href="/pwa-192x192.png" />
	{#if registerSw}<script src="/registerSW.js"></script>{/if}
</svelte:head>
<ModeWatcher defaultMode={data.theme} />
{@render children()}
<Toaster />
