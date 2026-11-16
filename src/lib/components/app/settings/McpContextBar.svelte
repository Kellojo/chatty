<script lang="ts" module>
	export interface ContextEntry {
		id: string;
		name: string;
		/** Estimated prompt tokens of the server's tool definitions. */
		tokens: number;
		toolCount: number | null;
		/** In every prompt; otherwise the tools load when the model searches for them. */
		always: boolean;
	}

	/** 1234 -> "1.2k", 840 -> "840". */
	export function formatTokens(n: number): string {
		if (n < 1000) return String(n);
		return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
	}
</script>

<script lang="ts">
	import { cn } from '$lib/utils.js';

	/** One stacked bar: how a list's servers split the tool context between them. */
	let { entries, label }: { entries: ContextEntry[]; label: string } = $props();

	/** Servers named under the bar; the rest are counted. */
	const NAMED = 3;

	const sorted = $derived([...entries].sort((a, b) => b.tokens - a.tokens));
	const total = $derived(sorted.reduce((sum, e) => sum + e.tokens, 0));
	const alwaysTotal = $derived(sorted.filter((e) => e.always).reduce((s, e) => s + e.tokens, 0));
	const hasOnDemand = $derived(sorted.some((e) => !e.always));
	const mixed = $derived(hasOnDemand && alwaysTotal > 0);
	/** How much of the total rides along in every prompt. */
	const modeNote = $derived(
		mixed
			? `${formatTokens(alwaysTotal)} in every prompt`
			: hasOnDemand
				? 'all on demand'
				: 'all in every prompt'
	);
	const share = (tokens: number) => Math.round((tokens / total) * 100);

	function hint(e: ContextEntry): string {
		const tools = e.toolCount ? ` · ${e.toolCount} tool${e.toolCount === 1 ? '' : 's'}` : '';
		const mode = e.always ? 'in every prompt' : 'loaded on demand';
		return `${e.name}: ≈ ${e.tokens.toLocaleString()} tokens (${share(e.tokens)}%)${tools} · ${mode}`;
	}
</script>

<div class="flex flex-col gap-2 px-(--card-spacing) pb-4">
	<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
		<p class="text-muted-foreground">
			<span class="font-medium text-foreground tabular-nums">≈ {formatTokens(total)}</span>
			tokens of tool definitions · {modeNote}
		</p>
		{#if mixed}
			<!-- Legend: the colour says how a server loads, the hover names it. -->
			<div class="flex items-center gap-3 text-muted-foreground" aria-hidden="true">
				<span class="flex items-center gap-1.5"
					><span class="size-2 rounded-full bg-(--chart-1)"></span>Always loaded</span
				>
				<span class="flex items-center gap-1.5"
					><span class="size-2 rounded-full bg-muted-foreground/45"></span>On demand</span
				>
			</div>
		{/if}
	</div>
	<!-- 2px gaps between segments; each one names its server on hover. -->
	<ul class="flex h-2.5 w-full gap-0.5" aria-label={label}>
		{#each sorted as entry (entry.id)}
			<li
				class={cn(
					'h-full min-w-1 rounded-[3px] transition-opacity hover:opacity-80',
					entry.always ? 'bg-(--chart-1)' : 'bg-muted-foreground/45'
				)}
				style:flex-grow={entry.tokens}
				style:flex-basis="0"
				title={hint(entry)}
				aria-label={hint(entry)}
			></li>
		{/each}
	</ul>
	<p class="truncate text-xs text-muted-foreground" aria-hidden="true">
		{#each sorted.slice(0, NAMED) as entry, i (entry.id)}{#if i > 0}<span class="mx-1.5">·</span
				>{/if}<span class="text-foreground/80">{entry.name}</span>
			<span class="tabular-nums">{share(entry.tokens)}%</span
			>{/each}{#if sorted.length > NAMED}<span class="mx-1.5">·</span>{sorted.length - NAMED} more{/if}
	</p>
</div>
