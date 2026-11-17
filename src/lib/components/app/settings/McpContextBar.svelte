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
	import AnimatedNumber from '../AnimatedNumber.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';

	/** One stacked bar: how a list's servers split the tool context between them. */
	let { entries, label }: { entries: ContextEntry[]; label: string } = $props();

	/** Servers named under the bar; the rest are counted. */
	const NAMED = 3;

	/** Always-loaded servers first, then on-demand ones; biggest first within each. */
	const sorted = $derived(
		[...entries].sort((a, b) => Number(b.always) - Number(a.always) || b.tokens - a.tokens)
	);
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
	/** Percent of the total, never a misleading "0%" for a server that has tokens. */
	function share(tokens: number): string {
		const pct = Math.round((tokens / total) * 100);
		return pct === 0 && tokens > 0 ? '<1' : String(pct);
	}
	const toolsLabel = (n: number | null) => (n ? `${n} tool${n === 1 ? '' : 's'}` : '');
	/** Same words as the legend. */
	const modeLabel = (e: ContextEntry) => (e.always ? 'Always loaded' : 'On demand');

	/** The segment whose popup is open; a tap opens it too, since touch has no hover. */
	let openId = $state<string | null>(null);

	/** Short accessible name; the popup carries the rest as the description. */
	const hint = (e: ContextEntry) =>
		`${e.name}, about ${e.tokens.toLocaleString()} tokens, ${modeLabel(e).toLowerCase()}`;
</script>

<div class="flex flex-col gap-2 px-(--card-spacing) pb-4">
	<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
		<p class="text-muted-foreground">
			<AnimatedNumber
				class="font-medium text-foreground tabular-nums"
				value={total}
				format="count"
				prefix="≈ "
			/>
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
	<!-- 2px gaps between segments; each segment opens its own server's details on hover. -->
	<Tooltip.Provider delayDuration={100} skipDelayDuration={400}>
		<ul class="flex h-2.5 w-full gap-0.5" aria-label={label}>
			{#each sorted as entry (entry.id)}
				<!-- The trigger reaches a little above and below the bar so thin segments are easy to hit. -->
				<li class="-my-1.5 flex min-w-2" style:flex-grow={entry.tokens} style:flex-basis="0">
					<Tooltip.Root
						open={openId === entry.id}
						onOpenChange={(open) => {
							if (open) openId = entry.id;
							else if (openId === entry.id) openId = null;
						}}
						disableCloseOnTriggerClick
					>
						<Tooltip.Trigger
							onclick={() => (openId = entry.id)}
							class="group flex w-full cursor-default py-1.5 outline-none"
							aria-label={hint(entry)}
						>
							<span
								class={cn(
									'h-full w-full rounded-[3px] transition-opacity duration-150 group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-1',
									// While one server's popup is open, the others step back.
									openId && openId !== entry.id && 'opacity-70',
									entry.always ? 'bg-(--chart-1)' : 'bg-muted-foreground/45'
								)}
							></span>
						</Tooltip.Trigger>
						<Tooltip.Content
							side="bottom"
							sideOffset={4}
							collisionPadding={16}
							class="flex max-w-[min(16rem,calc(100vw-2rem))] flex-col items-start gap-0.5 py-2 text-left"
						>
							<p class="line-clamp-2 font-semibold break-words">{entry.name}</p>
							<p class="tabular-nums">
								<span class="font-medium">≈ {entry.tokens.toLocaleString()} tokens</span>
								<span class="text-background/75">· {share(entry.tokens)}% of total</span>
							</p>
							<p class="flex items-center gap-1.5 whitespace-nowrap text-background/80">
								<span
									class={cn(
										'size-2 shrink-0 rounded-full',
										entry.always ? 'bg-(--chart-1)' : 'bg-background/60'
									)}
								></span>
								{[modeLabel(entry), toolsLabel(entry.toolCount)].filter(Boolean).join(' · ')}
							</p>
						</Tooltip.Content>
					</Tooltip.Root>
				</li>
			{/each}
		</ul>
	</Tooltip.Provider>
	<!-- Fades while a popup (which opens over it) shows the details instead. -->
	<p
		class={cn(
			'truncate text-xs text-muted-foreground transition-opacity duration-150',
			openId && 'opacity-0'
		)}
		aria-hidden="true"
	>
		{#each sorted.slice(0, NAMED) as entry, i (entry.id)}{#if i > 0}<span class="mx-1.5">·</span
				>{/if}<span class="text-foreground/80">{entry.name}</span>
			<span class="tabular-nums">{share(entry.tokens)}%</span
			>{/each}{#if sorted.length > NAMED}<span class="max-sm:hidden"
				><span class="mx-1.5">·</span>{sorted.length - NAMED} more</span
			>{/if}
	</p>
</div>
