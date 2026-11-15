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
	import { ALLOWED_IMAGE_PREFIXES } from './image-url.js';

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
			base: 'my-3 in-[li]:my-1 ml-0 list-outside list-disc pl-6 whitespace-normal text-foreground [&.contains-task-list]:pl-0'
		},
		// Two-digit markers ("10.") need a wider gutter so they don't hang outside the column.
		ol: {
			base: 'my-3 in-[li]:my-1 ml-0 list-outside pl-6 whitespace-normal text-foreground [&:has(>li:nth-child(10))]:pl-9 [&:has(>li[value])]:pl-9 [&[start]]:pl-9'
		},
		// Links render as buttons (link safety). The default wrap-anywhere let a link split mid-word in
		// narrow table cells; break-word only breaks a word that can't fit on its own line.
		link: { base: 'text-primary font-medium underline wrap-break-word hover:text-primary/80' },
		// One card like code blocks: a header strip with the table actions, then the table edge to edge.
		table: {
			wrapper:
				'relative my-4 flex flex-col gap-0 overflow-hidden rounded-xl border border-border bg-card p-0',
			toolbar:
				"ml-0 flex h-10 w-full items-center justify-end gap-2 rounded-none border-0 border-b border-border bg-transparent px-2 py-0 text-muted-foreground supports-[backdrop-filter]:bg-transparent supports-[backdrop-filter]:backdrop-blur-none before:mr-auto before:pl-1 before:text-xs before:content-['Table'] [&_[data-streamdown-table-download]]:flex-row-reverse [&_[data-streamdown-table-download]]:p-0",
			// The fullscreen view sits on the page background, so its scroll shadows cover with that.
			container:
				'md-scroll-shadows max-w-full overflow-x-auto rounded-none border-0 in-data-[streamdown=table-fullscreen]:[--scroll-cover:var(--background)]',
			table: 'w-full min-w-full border-collapse'
		},
		thead: { base: 'bg-muted/60' },
		// Rows are separated by hairlines; the last one sits on the card's own border.
		tr: { base: 'border-b border-border last:border-b-0 hover:bg-muted/30' },
		th: {
			base: 'min-w-0 max-w-[400px] px-3 py-2.5 align-bottom text-sm font-semibold whitespace-nowrap text-foreground first:pl-4 last:pr-4'
		},
		// Prose columns get room to breathe (the table scrolls sideways rather than squeezing
		// words onto one line each); long unbroken tokens inside code wrap anywhere.
		td: {
			base: 'min-w-28 max-w-[400px] px-3 py-2.5 align-top text-sm leading-6 wrap-break-word text-foreground first:pl-4 last:pr-4 [&_code]:break-all'
		},
		codespan: {
			base: 'rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground box-decoration-clone'
		},
		// Task boxes are drawn by hand: the native disabled checkbox is greyed out to near-invisible.
		li: {
			base: 'py-0.5 leading-7 marker:text-muted-foreground',
			checkbox:
				'mr-1 inline-grid size-4 -translate-y-px appearance-none place-content-center rounded-[4px] border border-foreground/40 align-middle checked:border-primary checked:bg-primary before:size-2.5 before:scale-0 before:bg-primary-foreground before:[clip-path:polygon(14%_44%,0_65%,50%_100%,100%_16%,80%_0%,43%_62%)] checked:before:scale-100'
		},
		// Streamdown merges this over its default `min-h-[500px]`, which left small diagrams
		// floating in a mostly empty box. The surface now hugs the SVG's natural height (capped so
		// tall charts stay pannable); pb-14 keeps the bottom-right zoom controls clear of the diagram.
		mermaid: {
			base: 'group relative h-auto min-h-28 max-h-[60vh] [&_[role=application]]:mx-auto [&_[role=application]]:w-fit [&_[data-mermaid-svg]>svg]:block items-center overflow-hidden rounded-none border-0 border-t border-border bg-background/60 pt-4 pb-14 in-data-[expanded=true]:max-h-none'
		},
		// One card: a header strip over the code, instead of a bordered box inside a padded card.
		code: {
			base: 'relative my-4 flex w-full flex-col gap-0 overflow-hidden rounded-xl border border-border bg-card p-0 [--sdm-bg:transparent]',
			header: 'flex h-10 items-center justify-between px-3 text-muted-foreground text-xs',
			// A fence without a language still labels its header strip.
			language: "ml-1 font-mono lowercase empty:before:content-['plain_text']",
			actions:
				'pointer-events-none sticky top-1 right-1 z-10 -mt-9 flex h-8 items-center justify-end pr-1 pointer-coarse:static pointer-coarse:-mt-9',
			buttons:
				'pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-1 supports-[backdrop-filter]:bg-transparent supports-[backdrop-filter]:backdrop-blur-none',
			container:
				'overflow-x-auto rounded-none border-0 border-t border-border bg-background/60 p-0 text-sm [--scroll-cover:color-mix(in_oklab,var(--background)_60%,var(--card))]',
			// The pre is what scrolls sideways, so it carries the padding and the scroll shadows.
			pre: 'md-scroll-shadows px-4 py-3'
		}
	};

	// Light: mermaid's 'default' is lavender; 'neutral' matches the stone palette. Dark: its 'dark'
	// nodes are near-black on our card, so lift them to a visible stone gray.
	// Both modes name the app font: mermaid measures labels with it, and without one the light
	// diagram fell back to monospace.
	const MERMAID_FONT = "'Inter Variable', ui-sans-serif, system-ui, sans-serif";
	const LIGHT_MERMAID = { theme: 'neutral', themeVariables: { fontFamily: MERMAID_FONT } } as const;
	const DARK_MERMAID = {
		// 'base' is the only theme that honours themeVariables in full.
		theme: 'base',
		themeVariables: {
			darkMode: true,
			background: 'transparent',
			secondaryColor: '#292524',
			tertiaryColor: '#1c1917',
			fontFamily: MERMAID_FONT,
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
		 * makes opening a long chat much cheaper. The parse mode is read once at
		 * mount, so a reply that finishes streaming isn't rebuilt. While it's true,
		 * an unclosed widget fence shows its loading state instead of an error.
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
		isAnimating={streaming}
		{urlTransform}
		class="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
		{mermaidConfig}
		baseTheme="shadcn"
		{shikiThemes}
		{plugins}
		{components}
		allowedImagePrefixes={ALLOWED_IMAGE_PREFIXES}
		linkSafety={{ enabled: true, renderModal: linkSafetyModal }}
		{theme}
	/>
</div>

<style>
	/*
	 * Streamdown hard-codes the mermaid zoom controls as a vertical stack in the bottom-left corner.
	 * Lay them out as a compact horizontal group in the bottom-right, styled like the code-block
	 * toolbar, so they don't stack under the header's copy/download group.
	 */
	:global(
		[data-streamdown-mermaid] [data-language='mermaid'] > div > div:has(> button[title='Zoom in'])
	) {
		top: auto;
		right: 0.375rem;
		bottom: 0.375rem;
		left: auto;
		flex-direction: row;
		gap: 0.25rem;
		border-color: var(--border);
		background-color: color-mix(in oklab, var(--card) 80%, transparent);
		padding: 0.125rem 0.375rem;
		transition: opacity 150ms;
	}
	/* On a pointer device the zoom controls appear on hover or focus, so they don't sit on a short
	   diagram at rest. Touch screens and the expanded view always show them. */
	@media (hover: hover) and (pointer: fine) {
		:global(
			[data-expanded='false'] [data-language='mermaid'] > div > div:has(> button[title='Zoom in'])
		) {
			opacity: 0;
		}
		:global(
			[data-expanded='false']:is(:hover, :focus-within)
				[data-language='mermaid']
				> div
				> div:has(> button[title='Zoom in'])
		) {
			opacity: 1;
		}
	}

	/*
	 * Expanded mermaid: Streamdown's fixed-overlay rule also matches the inner pan surface, which
	 * then covered the header (and its exit button). Keep the overlay on the card only and let the
	 * diagram body fill it.
	 */
	:global([data-expanded='true'] [data-language='mermaid']) {
		flex: 1 1 0%;
		min-height: 0;
		height: auto !important;
	}
	:global([data-expanded='true'] [data-expanded='true']) {
		position: relative;
		top: auto;
		left: auto;
		z-index: auto;
		width: 100%;
		height: 100%;
		max-height: none;
	}

	/* Streamdown's fullscreen table closes with a bare "X" label; draw a proper glyph instead. */
	:global([data-streamdown='table-fullscreen-toolbar'] > button:last-child) {
		font-size: 0;
	}
	:global([data-streamdown='table-fullscreen-toolbar'] > button:last-child::after) {
		content: '×';
		font-size: 1.125rem;
		line-height: 1;
	}

	/*
	 * Scroll shadows: a wide table or code line shows a soft edge on the side that has more columns to scroll
	 * to. The `local` covers move with the content and hide the `scroll` shadows at either end.
	 */
	:global(.md-scroll-shadows) {
		--cover: var(--scroll-cover, var(--card));
		background:
			linear-gradient(to right, var(--cover) 30%, transparent) left / 2.5rem 100% no-repeat local,
			linear-gradient(to left, var(--cover) 30%, transparent) right / 2.5rem 100% no-repeat local,
			radial-gradient(
					farthest-side at 0 50%,
					color-mix(in oklab, var(--foreground) 22%, transparent),
					transparent
				)
				left / 0.75rem 100% no-repeat scroll,
			radial-gradient(
					farthest-side at 100% 50%,
					color-mix(in oklab, var(--foreground) 22%, transparent),
					transparent
				)
				right / 0.75rem 100% no-repeat scroll,
			var(--cover);
	}
</style>
