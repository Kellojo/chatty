<script lang="ts" module>
	import type { PluginConfig, StreamdownProps } from 'streamdown-svelte';
	import { mode } from 'mode-watcher';
	import MarkdownImage from './markdown-image.svelte';
	import MarkdownLink from './markdown-link.svelte';
	import WeatherWidget from './weather-widget.svelte';
	import ChartWidget from './chart-widget.svelte';
	import MapWidget from './map-widget.svelte';
	import FileWidget from './file-widget.svelte';
	import ChatsWidget from './chats-widget.svelte';
	import ClockWidget from './clock-widget.svelte';
	import LinksWidget from './links-widget.svelte';
	import CalcWidget from './calc-widget.svelte';
	import MemoryWidget from './memory-widget.svelte';
	import AgentWidget from './agent-widget.svelte';
	import MealplanWidget from './mealplan-widget.svelte';
	import EventsWidget from './events-widget.svelte';
	import { createCachedCodePlugin, streamdownHighlighter } from './code-highlight.js';

	// Import Shiki themes
	import githubLightDefault from '@shikijs/themes/github-light-default';
	import githubDarkDefault from '@shikijs/themes/github-dark-default';
	import { math } from '@streamdown-svelte/math';
	import { mermaid } from '@streamdown-svelte/mermaid';

	// The options below are the same for every message, so they're built once
	// instead of for each rendered message.

	// Both themes are registered up front: Streamdown's shared highlighter only
	// loads the themes it knows when it's created.
	const shikiThemes = {
		'github-light-default': githubLightDefault,
		'github-dark-default': githubDarkDefault
	};
	const LIGHT_THEMES: [typeof githubLightDefault, typeof githubLightDefault] = [
		githubLightDefault,
		githubLightDefault
	];
	const DARK_THEMES: [typeof githubDarkDefault, typeof githubDarkDefault] = [
		githubDarkDefault,
		githubDarkDefault
	];

	const plugins: PluginConfig = {
		// Caches highlighted blocks, so reopening a chat doesn't tokenize its code
		// again. The pair is the app's active theme, so the code follows its mode.
		code: createCachedCodePlugin(streamdownHighlighter, () =>
			mode.current === 'dark' ? DARK_THEMES : LIGHT_THEMES
		),
		math,
		mermaid,
		renderers: [
			{ language: 'weather', component: WeatherWidget },
			{ language: 'chart', component: ChartWidget },
			{ language: 'map', component: MapWidget },
			{ language: 'file', component: FileWidget },
			{ language: 'chats', component: ChatsWidget },
			{ language: 'clock', component: ClockWidget },
			{ language: 'links', component: LinksWidget },
			{ language: 'calc', component: CalcWidget },
			{ language: 'memory', component: MemoryWidget },
			{ language: 'agent', component: AgentWidget },
			{ language: 'mealplan', component: MealplanWidget },
			{ language: 'events', component: EventsWidget }
		]
	};

	const components = { img: MarkdownImage, a: MarkdownLink };

	const theme: StreamdownProps['theme'] = {
		h1: { base: 'mt-8 mb-3 text-3xl font-semibold text-foreground' },
		h2: { base: 'mt-8 mb-3 text-2xl font-semibold text-foreground' },
		h3: { base: 'mt-7 mb-2.5 text-xl font-semibold text-foreground' },
		h4: { base: 'mt-6 mb-2 text-lg font-semibold text-foreground' },
		h5: { base: 'mt-5 mb-2 text-base font-semibold text-foreground' },
		h6: { base: 'mt-5 mb-2 text-sm font-semibold text-foreground' },
		paragraph: { base: 'my-3 leading-7 text-foreground' },
		ul: {
			base: 'my-3 in-[li]:my-1 ml-0 list-outside list-disc pl-6 whitespace-normal text-foreground'
		},
		ol: { base: 'my-3 in-[li]:my-1 ml-0 list-outside pl-6 whitespace-normal text-foreground' },
		th: {
			base: 'min-w-0 max-w-[400px] px-3 py-2 text-sm font-semibold text-foreground max-sm:px-2'
		},
		// Short cells ("830 ms") stay on one line; long prose still wraps. The table scrolls sideways.
		td: {
			base: 'min-w-16 max-w-[400px] px-3 py-2 text-sm break-words text-foreground max-sm:px-2'
		},
		codespan: { base: 'rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground' },
		li: { base: 'py-0.5 leading-7 marker:text-muted-foreground', checkbox: 'mr-2' },
		// Streamdown merges this over its default `min-h-[500px]`, which left small diagrams
		// floating in a mostly empty box. The surface now hugs the SVG's natural height (capped so
		// tall charts stay pannable); pt-11 keeps the top-right zoom controls clear of the diagram.
		mermaid: {
			base: 'group relative h-auto min-h-28 max-h-[60vh] items-center overflow-hidden rounded-none border-0 border-t border-border bg-background/60 pt-11 pb-4 in-data-[expanded=true]:max-h-none'
		},
		table: {
			wrapper: 'my-4 flex flex-col gap-1 rounded-xl border border-border bg-card p-1.5',
			toolbar:
				'ml-auto flex w-fit items-center justify-end gap-1 rounded-md bg-card/80 px-1 supports-[backdrop-filter]:bg-card/70 supports-[backdrop-filter]:backdrop-blur'
		},
		// One card: a header strip over the code, instead of a bordered box inside a padded card.
		code: {
			base: 'relative my-4 flex w-full flex-col gap-0 overflow-hidden rounded-xl border border-border bg-card p-0 [--sdm-bg:transparent]',
			header: 'flex h-10 items-center justify-between px-3 text-muted-foreground text-xs',
			actions:
				'pointer-events-none sticky top-1 right-1 z-10 -mt-9 flex h-8 items-center justify-end pr-1 pointer-coarse:static pointer-coarse:-mt-9',
			buttons:
				'pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-border bg-card/80 px-1.5 py-1 supports-[backdrop-filter]:bg-card/70 supports-[backdrop-filter]:backdrop-blur',
			container:
				'overflow-x-auto rounded-none border-0 border-t border-border bg-background/60 px-4 py-3 text-sm'
		}
	};

	// Light: mermaid's 'default' is lavender; 'neutral' matches the stone palette. Dark: its 'dark'
	// nodes are near-black on our card, so lift them to a visible stone gray.
	const LIGHT_MERMAID = { theme: 'neutral' } as const;
	const DARK_MERMAID = {
		// 'base' is the only theme that honours themeVariables in full.
		theme: 'base',
		themeVariables: {
			darkMode: true,
			background: 'transparent',
			secondaryColor: '#292524',
			tertiaryColor: '#1c1917',
			fontFamily: 'inherit',
			primaryColor: '#3a3835',
			primaryBorderColor: '#78716c',
			primaryTextColor: '#e7e5e4',
			lineColor: '#a8a29e'
		}
	} as const;
</script>

<script lang="ts">
	import { setContext, untrack } from 'svelte';
	import { cn } from '$lib/utils';
	import { Streamdown } from 'streamdown-svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import LinkSafetyModal from './link-safety-modal.svelte';
	import { codingAssetUrl, escapeLocalImagePaths, isLocalImagePath } from '$lib/coding-assets.js';
	import { t3ThreadLinkToPath } from '$lib/t3-thread-links.js';
	import { loadKatexCss, mayContainMath } from './katex-css.js';

	type Props = {
		content: string;
		id?: string;
		class?: string;
		conversationId?: string | null;
		/**
		 * Whether the content may still grow. Finished content is parsed once as
		 * a whole instead of block by block with incomplete-markdown repair, which
		 * makes opening a long chat much cheaper. Read once at mount, so a reply
		 * that finishes streaming isn't rebuilt.
		 */
		streaming?: boolean;
	} & Omit<StreamdownProps, 'content' | 'class' | 'static' | 'mode'> &
		Omit<HTMLAttributes<HTMLDivElement>, 'content'>;

	let {
		content,
		id,
		class: className,
		conversationId,
		streaming = true,
		...restProps
	}: Props = $props();

	const isStatic = untrack(() => !streaming);

	setContext(
		'conversationId',
		untrack(() => conversationId)
	);

	// Coding agents embed screenshots by their path on the coding machine.
	// Streamdown would block those (`C:` reads as a URL scheme), so they are
	// rewritten to Chatty's relay to the T3 server before its URL checks run.
	const markdown = $derived(conversationId ? escapeLocalImagePaths(content) : content);
	function urlTransform(url: string, key: string): string {
		if (key === 'src' && conversationId && isLocalImagePath(url)) {
			return codingAssetUrl(conversationId, url);
		}
		// T3 Code thread links open the thread's conversation in Chatty.
		if (key === 'href') return t3ThreadLinkToPath(url) ?? url;
		return url;
	}

	$effect(() => {
		if (mayContainMath(markdown)) loadKatexCss();
	});

	const mermaidConfig = $derived(mode.current === 'dark' ? DARK_MERMAID : LIGHT_MERMAID);
</script>

{#snippet linkSafetyModal(props: {
	url: string;
	isOpen: boolean;
	onClose: () => void;
	onConfirm: () => void;
})}
	<LinkSafetyModal {...props} />
{/snippet}

<!-- wrap-anywhere: long unbroken tokens (inline JSON, hashes, paths) wrap instead of widening the chat. -->
<div {id} class={cn('wrap-anywhere', className)} {...restProps}>
	<Streamdown
		content={markdown}
		static={isStatic}
		{urlTransform}
		class="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
		{mermaidConfig}
		baseTheme="shadcn"
		{shikiThemes}
		{plugins}
		{components}
		linkSafety={{ enabled: true, renderModal: linkSafetyModal }}
		{theme}
	/>
</div>

<style>
	/*
	 * Streamdown hard-codes the mermaid zoom controls as a vertical stack in the bottom-left corner.
	 * Lay them out as a compact horizontal group in the top-right, styled like the code-block toolbar.
	 */
	:global(
		[data-streamdown-mermaid] [data-language='mermaid'] > div > div:has(> button[title='Zoom in'])
	) {
		top: 0.375rem;
		right: 0.375rem;
		bottom: auto;
		left: auto;
		flex-direction: row;
		gap: 0.25rem;
		border-color: var(--border);
		background-color: color-mix(in oklab, var(--card) 80%, transparent);
		padding: 0.125rem 0.375rem;
	}
</style>
