<script lang="ts">
	// An HTML page a coding agent published with T3 Code's `html_render` tool,
	// shown inline in the reply. The page runs sandboxed on an opaque origin
	// (see HTML_RENDER_CSP); Chatty sends it the theme and it reports its height
	// and the links it wants opened, using T3 Code's host protocol.
	import { mode } from 'mode-watcher';
	import LinkSafetyModal from '$lib/components/ai/markdown/link-safety-modal.svelte';
	import {
		HTML_RENDER_MAX_FIT_HEIGHT,
		OPEN_LINK_METHOD,
		SIZE_CHANGED_METHOD,
		clampHtmlRenderHeight,
		hostContextMessage,
		htmlRenderHeightAt,
		readHtmlRender
	} from '$lib/html-render.js';

	type Props = {
		conversationId: string;
		part: {
			type: string;
			toolName?: string;
			toolCallId?: string;
			state?: string;
			input?: unknown;
			output?: unknown;
		};
	};

	let { conversationId, part }: Props = $props();

	const ref = $derived(readHtmlRender(part));
	const src = $derived(
		`/api/coding/tasks/${encodeURIComponent(conversationId)}/html?call=${encodeURIComponent(part.toolCallId ?? '')}`
	);

	let frame = $state<HTMLIFrameElement | null>(null);
	let width = $state(0);
	let reported = $state<number | null>(null);
	let loaded = $state(false);
	let pendingLink = $state<string | null>(null);

	const height = $derived(reported ?? (ref ? htmlRenderHeightAt(ref, width) : 0));

	// Chatty's tokens under the names T3 pages use (its `--accent` is a brand color).
	const DIRECT = [
		'background',
		'foreground',
		'muted',
		'muted-foreground',
		'card',
		'card-foreground',
		'popover',
		'popover-foreground',
		'secondary',
		'secondary-foreground',
		'border',
		'input',
		'ring',
		'primary',
		'primary-foreground',
		'destructive',
		'success',
		'success-foreground',
		'info',
		'info-foreground',
		'chart-1',
		'chart-2',
		'chart-3',
		'chart-4',
		'chart-5',
		'radius'
	];

	function themeVariables(dark: boolean): Record<string, string> {
		const root = getComputedStyle(document.documentElement);
		const get = (name: string) => root.getPropertyValue(`--${name}`).trim();
		const vars: Record<string, string> = {};
		for (const name of DIRECT) {
			const value = get(name);
			if (value) vars[`--${name}`] = value;
		}
		const surface = (color: string) => `color-mix(in oklab, ${color} 14%, transparent)`;
		const primary = get('primary');
		const destructive = get('destructive');
		const warning = '#f59e0b';
		Object.assign(vars, {
			'--accent': primary,
			'--accent-foreground': get('primary-foreground'),
			'--accent-surface': surface(primary),
			'--accent-surface-foreground': get('foreground'),
			'--destructive-foreground': destructive,
			'--destructive-surface': surface(destructive),
			'--warning': warning,
			'--warning-foreground': dark ? '#fbbf24' : '#b45309',
			'--warning-surface': surface(warning),
			'--code-background': get('muted'),
			'--code-foreground': get('foreground'),
			'--chart-6': dark ? '#a3e635' : '#65a30d',
			'--font-sans': getComputedStyle(document.body).fontFamily,
			'--font-mono': get('font-mono') || 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
		});
		return vars;
	}

	function sendTheme() {
		const win = frame?.contentWindow;
		if (!win) return;
		const dark = mode.current === 'dark';
		// The page has an opaque origin, so it can only be addressed as '*'.
		win.postMessage(hostContextMessage(dark ? 'dark' : 'light', themeVariables(dark)), '*');
	}

	// Re-theme when the mode changes, once the new theme's CSS applies.
	$effect(() => {
		void mode.current;
		if (!loaded) return;
		const id = requestAnimationFrame(sendTheme);
		return () => cancelAnimationFrame(id);
	});

	function onMessage(event: MessageEvent) {
		if (!frame || event.source !== frame.contentWindow) return;
		const data = event.data as { jsonrpc?: unknown; method?: unknown; params?: unknown };
		if (!data || data.jsonrpc !== '2.0') return;
		const params = (data.params ?? {}) as Record<string, unknown>;
		if (data.method === SIZE_CHANGED_METHOD) {
			const h = params.height;
			if (typeof h === 'number' && Number.isFinite(h) && h > 0) {
				reported = clampHtmlRenderHeight(h, HTML_RENDER_MAX_FIT_HEIGHT);
			}
		} else if (data.method === OPEN_LINK_METHOD && typeof params.url === 'string') {
			let url: URL;
			try {
				url = new URL(params.url);
			} catch {
				return;
			}
			if (url.protocol === 'http:' || url.protocol === 'https:') pendingLink = url.href;
		}
	}

	function onLoad() {
		loaded = true;
		sendTheme();
	}
</script>

<svelte:window onmessage={onMessage} />

{#if ref}
	<div class="relative w-full" bind:clientWidth={width} style:height="{height}px">
		{#if !loaded}
			<div class="absolute inset-0 animate-pulse rounded-lg bg-muted/40"></div>
		{/if}
		<iframe
			bind:this={frame}
			{src}
			title={ref.title}
			sandbox="allow-scripts allow-forms allow-downloads"
			referrerpolicy="no-referrer"
			loading="lazy"
			onload={onLoad}
			class="block size-full border-0 bg-transparent transition-opacity"
			class:opacity-0={!loaded}
		></iframe>
	</div>
	<LinkSafetyModal
		url={pendingLink ?? ''}
		isOpen={pendingLink !== null}
		onClose={() => (pendingLink = null)}
		onConfirm={() => {
			if (pendingLink) window.open(pendingLink, '_blank', 'noopener,noreferrer');
			pendingLink = null;
		}}
	/>
{/if}
