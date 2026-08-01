<script lang="ts">
	import { cn } from '$lib/utils';
	import { Streamdown, type StreamdownProps } from 'streamdown-svelte';
	import { mode } from 'mode-watcher';
	import type { HTMLAttributes } from 'svelte/elements';
	import MarkdownImage from './markdown-image.svelte';
	import LinkSafetyModal from './link-safety-modal.svelte';
	import WeatherWidget from './weather-widget.svelte';

	// Import Shiki themes
	import githubLightDefault from '@shikijs/themes/github-light-default';
	import githubDarkDefault from '@shikijs/themes/github-dark-default';
	import { math } from '@streamdown-svelte/math';
	import { mermaid } from '@streamdown-svelte/mermaid';
	import 'katex/dist/katex.min.css';

	type Props = {
		content: string;
		id?: string;
		class?: string;
	} & Omit<StreamdownProps, 'content' | 'class'> &
		Omit<HTMLAttributes<HTMLDivElement>, 'content'>;

	let { content, id, class: className, ...restProps }: Props = $props();
	let currentTheme = $derived(
		mode.current === 'dark' ? 'github-dark-default' : 'github-light-default'
	);
</script>

{#snippet linkSafetyModal(props: {
	url: string;
	isOpen: boolean;
	onClose: () => void;
	onConfirm: () => void;
})}
	<LinkSafetyModal {...props} />
{/snippet}

<div {id} class={cn(className)} {...restProps}>
	<Streamdown
		{content}
		class="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
		shikiTheme={currentTheme}
		baseTheme="shadcn"
		shikiThemes={{
			'github-light-default': githubLightDefault,
			'github-dark-default': githubDarkDefault
		}}
		plugins={{ math, mermaid, renderers: [{ language: 'weather', component: WeatherWidget }] }}
		components={{ img: MarkdownImage }}
		linkSafety={{ enabled: true, renderModal: linkSafetyModal }}
		theme={{
			h1: { base: 'mt-8 mb-3 text-3xl font-semibold text-foreground' },
			h2: { base: 'mt-8 mb-3 text-2xl font-semibold text-foreground' },
			h3: { base: 'mt-7 mb-2.5 text-xl font-semibold text-foreground' },
			h4: { base: 'mt-6 mb-2 text-lg font-semibold text-foreground' },
			h5: { base: 'mt-5 mb-2 text-base font-semibold text-foreground' },
			h6: { base: 'mt-5 mb-2 text-sm font-semibold text-foreground' },
			ul: { base: 'ml-0 list-outside list-disc pl-6 whitespace-normal text-foreground' },
			ol: { base: 'ml-0 list-outside pl-6 whitespace-normal text-foreground' },
			code: {
				base: 'relative my-4 flex w-full flex-col gap-2 rounded-xl border border-border bg-white p-2 [--sdm-bg:theme(colors.white)] dark:bg-sidebar dark:[--sdm-bg:transparent]',
				header: 'flex h-8 items-center justify-between pr-1 text-muted-foreground text-xs',
				actions:
					'pointer-events-none sticky top-2 right-1 z-10 -mt-10 flex h-8 items-center justify-end',
				buttons:
					'pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-border bg-white/80 px-1.5 py-1 supports-[backdrop-filter]:bg-white/70 supports-[backdrop-filter]:backdrop-blur dark:border-sidebar dark:bg-sidebar/80 dark:supports-[backdrop-filter]:bg-sidebar/70'
			}
		}}
	/>
</div>
