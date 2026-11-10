<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { formatCost, formatLatency, formatToken } from '$lib/formats.js';
	import type { MessageUsage } from '$lib/types.js';

	let {
		usage,
		open,
		onOpenChange
	}: {
		usage: MessageUsage;
		open: boolean;
		onOpenChange: (open: boolean) => void;
	} = $props();

	interface PromptShare {
		label: string;
		color: string;
		/** Fraction of the accounted-for prompt, 0..1. */
		fraction: number;
		/** Approximate input tokens; sums exactly to `inputTokens`. */
		tokens: number | null;
	}

	// Relative share of each prompt contributor (rough, character-based estimate).
	const shares = $derived.by((): PromptShare[] | null => {
		const chars = usage.promptChars;
		if (!chars) return null;
		const total = chars.system + chars.skills + chars.tools + chars.messages;
		if (total <= 0) return null;
		const list = [
			{ label: 'Messages', color: 'bg-chart-1', fraction: chars.messages / total },
			{ label: 'Tools', color: 'bg-chart-2', fraction: chars.tools / total },
			{ label: 'Skills', color: 'bg-chart-3', fraction: chars.skills / total },
			{ label: 'System', color: 'bg-chart-4', fraction: chars.system / total }
		]
			.filter((s) => s.fraction > 0)
			.sort((a, b) => b.fraction - a.fraction);
		const tokens = splitTokens(
			list.map((s) => s.fraction),
			usage.inputTokens
		);
		return list.map((s, i) => ({ ...s, tokens: tokens?.[i] ?? null }));
	});

	// Largest-remainder split so the per-category estimates add up to the total.
	function splitTokens(fractions: number[], total: number | null): number[] | null {
		if (total == null) return null;
		const raw = fractions.map((f) => f * total);
		const out = raw.map(Math.floor);
		let left = total - out.reduce((a, b) => a + b, 0);
		const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
		for (const [, i] of order) {
			if (left-- <= 0) break;
			out[i]++;
		}
		return out;
	}

	const throughput = $derived(
		usage.outputTokens == null || usage.latencyMs == null || usage.latencyMs <= 0
			? null
			: usage.outputTokens / (usage.latencyMs / 1000)
	);

	function formatPct(fraction: number): string {
		const pct = fraction * 100;
		return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
	}

	const barLabel = $derived(
		shares ? shares.map((s) => `${s.label} ${formatPct(s.fraction)}`).join(', ') : ''
	);
</script>

{#snippet empty()}
	<span class="font-normal text-muted-foreground">—</span>
{/snippet}

{#snippet tokenStat(label: string, value: number | null)}
	<div class="px-3">
		<dt class="text-xs text-muted-foreground">{label}</dt>
		<dd class="text-sm font-semibold tabular-nums">
			{#if value == null}{@render empty()}{:else}{formatToken(value)}{/if}
		</dd>
	</div>
{/snippet}

<Dialog.Root {open} {onOpenChange}>
	<Dialog.Content class="gap-4 sm:max-w-sm">
		<Dialog.Header class="pr-8">
			<Dialog.Title class="text-xs font-normal text-muted-foreground">Generation info</Dialog.Title>
			<Dialog.Description class="font-mono text-sm [overflow-wrap:anywhere] text-foreground">
				{usage.modelId}
			</Dialog.Description>
		</Dialog.Header>

		<dl class="grid grid-cols-3 gap-2">
			<div class="rounded-xl border border-border/60 px-3 py-2.5">
				<dt class="truncate text-xs text-muted-foreground">Latency</dt>
				<dd class="mt-0.5 text-base font-semibold tabular-nums">
					{#if usage.latencyMs == null}{@render empty()}{:else}{formatLatency(usage.latencyMs)}{/if}
				</dd>
			</div>
			<div class="rounded-xl border border-border/60 px-3 py-2.5">
				<dt
					class="truncate text-xs text-muted-foreground"
					title="Output tokens per second, including time to first token"
				>
					Speed<span class="sr-only">, output tokens per second including time to first token</span>
				</dt>
				<dd class="mt-0.5 text-base font-semibold whitespace-nowrap tabular-nums">
					{#if throughput == null}
						{@render empty()}
					{:else}
						{throughput >= 100 ? Math.round(throughput) : throughput.toFixed(1)}<span
							class="ml-0.5 text-xs font-normal text-muted-foreground">tok/s</span
						>
					{/if}
				</dd>
			</div>
			<div class="rounded-xl border border-border/60 px-3 py-2.5">
				<dt class="truncate text-xs text-muted-foreground">Cost</dt>
				{#if usage.costUsd == null}
					<dd class="mt-0.5 truncate text-sm leading-6 text-muted-foreground">Not priced</dd>
				{:else}
					<dd class="mt-0.5 text-base font-semibold tabular-nums">
						{formatCost(usage.costUsd)}
					</dd>
				{/if}
			</div>
		</dl>

		<section class="rounded-xl border border-border/60 p-3">
			<h3 class="text-xs font-medium text-muted-foreground">Tokens</h3>
			<!-- -mx-3 + px-3 per column lines the values up with the stat tiles above. -->
			<dl class="-mx-3 mt-2 grid grid-cols-3 gap-2">
				{@render tokenStat('Input', usage.inputTokens)}
				{@render tokenStat('Output', usage.outputTokens)}
				{@render tokenStat('Total', usage.totalTokens)}
			</dl>

			{#if shares}
				<div class="mt-3 border-t border-border/60 pt-3">
					<h4 class="text-xs font-medium text-muted-foreground">Input breakdown (approx.)</h4>
					<div
						class="mt-2 flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
						role="img"
						aria-label="Input breakdown: {barLabel}"
					>
						{#each shares as s (s.label)}
							<div class={s.color} style:flex="{s.fraction} 1 0" style:min-width="4px"></div>
						{/each}
					</div>
					<ul class="mt-2 space-y-1 text-sm">
						{#each shares as s (s.label)}
							<li class="flex items-center gap-2">
								<span class="size-2 shrink-0 rounded-full {s.color}" aria-hidden="true"></span>
								<span class="flex-1 text-foreground/80">{s.label}</span>
								{#if s.tokens != null}
									<span class="text-muted-foreground tabular-nums">{formatToken(s.tokens)}</span>
								{/if}
								<span class="w-10 text-right font-medium tabular-nums">{formatPct(s.fraction)}</span
								>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</section>
	</Dialog.Content>
</Dialog.Root>
