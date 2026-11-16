<script lang="ts">
	import type { Snippet } from 'svelte';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { Markdown } from '$lib/components/ai/markdown/index.js';
	import { cn } from '$lib/utils.js';

	/**
	 * One labelled part of an opened agent row (Task, Result, Error, Question):
	 * a small caption over the text. Plain text (a task, an error) sits in a
	 * bordered box and keeps its line breaks; a markdown report reads like a
	 * reply, on the page itself, so its tables and code blocks keep their own
	 * cards. Long text is cut at a fixed height, with a toggle to show it all.
	 */
	let {
		label,
		text,
		markdown = false,
		tone = 'default',
		note,
		children
	}: {
		label: string;
		text?: string;
		/** Render `text` as markdown (a report) instead of as written. */
		markdown?: boolean;
		tone?: 'default' | 'error' | 'question';
		/** A line under the text (e.g. that it was shortened). */
		note?: Snippet;
		/** Custom contents instead of `text`. */
		children?: Snippet;
	} = $props();

	const boxed = $derived(!markdown || !!children);
	let expanded = $state(false);
	/** Whether the text is taller than the cut, so the toggle is worth showing. */
	let clipped = $state(false);
	const contentId = $props.id();

	/** Where a cut report ends: below the last whole block that fits, never inside one. */
	let cutAt = $state<number | null>(null);

	/** The report's blocks: the first element that lays out more than one child. */
	function blocksOf(node: HTMLElement): Element[] {
		let el: Element | null = node;
		for (let depth = 0; el && depth < 6; depth++) {
			if (el.children.length > 1) return [...el.children];
			el = el.firstElementChild;
		}
		return [];
	}

	function measure(node: HTMLElement) {
		const update = () => {
			// Measured against the cut even while expanded, so "Show less" stays offered.
			const limit = parseFloat(getComputedStyle(node).getPropertyValue('--cut')) || Infinity;
			clipped = node.scrollHeight > limit + 4;
			if (!clipped || boxed) {
				cutAt = null;
				return;
			}
			const top = node.getBoundingClientRect().top - node.scrollTop;
			let end = 0;
			for (const block of blocksOf(node)) {
				const bottom = block.getBoundingClientRect().bottom - top;
				if (bottom > limit) {
					// A block ending just past the cut (a table after a one-line intro) is
					// shown whole rather than leaving the cut with little more than the intro.
					if (bottom <= limit * 1.25) end = bottom;
					break;
				}
				end = bottom;
			}
			// A short clean cut beats one through a table; only a first block taller than the cut is cut inside.
			cutAt = end > 0 ? Math.ceil(end) : null;
			// Taking in that last block can leave nothing below it: then nothing is cut at all.
			if (cutAt !== null && cutAt >= node.scrollHeight - 4) {
				clipped = false;
				cutAt = null;
			}
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(node);
		if (node.firstElementChild) observer.observe(node.firstElementChild);
		// Text rewraps when the web font arrives; the cut has to follow it.
		let alive = true;
		void document.fonts?.ready.then(() => alive && update());
		return () => {
			alive = false;
			observer.disconnect();
		};
	}
</script>

<section class="min-w-0" aria-label={label}>
	<p class="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
	<div class="relative">
		<div
			{@attach measure}
			id={contentId}
			style:max-height={!expanded && cutAt !== null ? `${cutAt}px` : undefined}
			class={cn(
				'overflow-hidden rounded-md [overflow-clip-margin:0]',
				boxed ? 'border bg-muted/40 px-3 py-2 [--cut:256px]' : '[--cut:320px]',
				!expanded && clipped && (boxed ? 'max-h-64' : 'max-h-80'),
				tone === 'error' && 'border-destructive/30 bg-destructive/5 text-destructive',
				tone === 'question' && 'border-warning/30 bg-warning/5'
			)}
		>
			{#if children}
				{@render children()}
			{:else if markdown}
				<!-- Chat replies use a roomy paragraph rhythm; a report inside a row reads tighter. -->
				<Markdown
					class="w-full max-w-none text-[13px] [&_h1]:mt-1 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:mt-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_li]:leading-6 [&_p]:my-2 [&_p]:leading-6"
					content={text ?? ''}
					streaming={false}
				/>
			{:else}
				<p class="text-[13px] leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap">{text}</p>
			{/if}
		</div>
		{#if clipped && !expanded && cutAt === null}
			<!-- A cut inside a block fades out so it reads as "more below", not as a broken line.
			     A cut between blocks ends cleanly and needs no fade. -->
			<div
				aria-hidden="true"
				class={cn(
					'pointer-events-none absolute inset-x-px bottom-px h-16 rounded-b-md bg-linear-to-t to-transparent',
					!boxed ? 'from-background' : tone === 'error' ? 'from-destructive/5' : 'from-muted/40'
				)}
			></div>
		{/if}
	</div>
	{#if clipped}
		<!-- Muted, unlike the row's links (AgentRowLinks): this reveals text here, they lead elsewhere. -->
		<button
			type="button"
			class="mt-1 inline-flex items-center gap-1 rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
			aria-expanded={expanded}
			aria-controls={contentId}
			onclick={() => (expanded = !expanded)}
		>
			{expanded ? 'Show less' : `Show full ${label.toLowerCase()}`}
			<ChevronDownIcon
				class={cn(
					'size-3.5 transition-transform motion-reduce:transition-none',
					expanded && 'rotate-180'
				)}
				aria-hidden="true"
			/>
		</button>
	{/if}
	{@render note?.()}
</section>
