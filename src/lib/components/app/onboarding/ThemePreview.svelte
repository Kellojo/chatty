<script lang="ts">
	import type { Theme } from '$lib/user-settings.js';

	/** A tiny Chatty window drawn in the given theme's colours, whatever the page's theme. */
	let { theme }: { theme: Theme } = $props();
</script>

{#snippet window(mode: 'light' | 'dark')}
	<div class="preview {mode} flex h-full w-full">
		<div class="side flex w-[28%] flex-col gap-1 p-1.5">
			<span class="h-1 w-3/4 rounded-full bg-[var(--line)]"></span>
			<span class="h-1 w-1/2 rounded-full bg-[var(--line)] opacity-70"></span>
			<span class="h-1 w-2/3 rounded-full bg-[var(--line)] opacity-70"></span>
		</div>
		<div class="flex flex-1 flex-col justify-end gap-1.5 p-2">
			<span class="ml-auto h-2.5 w-1/2 rounded-md bg-[var(--bubble)]"></span>
			<span class="h-1 w-5/6 rounded-full bg-[var(--line)]"></span>
			<span class="h-1 w-2/3 rounded-full bg-[var(--line)]"></span>
			<span class="mt-1 h-3 w-full rounded-md border border-[var(--border)] bg-[var(--card)]"
			></span>
		</div>
	</div>
{/snippet}

<div
	class="relative aspect-[16/9] overflow-hidden rounded-xl border border-black/10 dark:border-white/10"
	aria-hidden="true"
>
	{#if theme === 'system'}
		<div class="absolute inset-0">{@render window('light')}</div>
		<div class="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
			{@render window('dark')}
		</div>
		<span class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-neutral-500/50"></span>
	{:else}
		{@render window(theme)}
	{/if}
	<!-- Keeps a near-white preview from melting into a white card. -->
	<span class="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-black/5 ring-inset"
	></span>
</div>

<style>
	/* Literal palettes from layout.css, so each tile shows its theme in either mode. */
	.preview.light {
		background: oklch(0.98 0.002 60);
		--side: oklch(0.96 0.003 60);
		--line: oklch(0.86 0.004 60);
		--bubble: oklch(0.92 0.004 60);
		--card: oklch(1 0 0);
		--border: oklch(0.9 0.004 60);
	}
	.preview.dark {
		background: oklch(0.16 0.002 60);
		--side: oklch(0.125 0.002 60);
		--line: oklch(0.34 0.003 60);
		--bubble: oklch(0.28 0.003 60);
		--card: oklch(0.205 0.0025 60);
		--border: oklch(0.3 0.003 60);
	}
	.side {
		background: var(--side);
	}
</style>
