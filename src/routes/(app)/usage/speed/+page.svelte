<script lang="ts">
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import AnimatedNumber, { type NumberFormatKind } from '$lib/components/app/AnimatedNumber.svelte';
	import EmptyState from '$lib/components/app/EmptyState.svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import SpeedBars, {
		FEW_SAMPLES,
		metricValue,
		SAMPLE_NOUN,
		type SpeedMetric,
		type SpeedRow
	} from '$lib/components/app/usage/SpeedBars.svelte';
	import SpeedByContext, { type ContextRow } from '$lib/components/app/usage/SpeedByContext.svelte';
	import { paygColor } from '$lib/components/app/usage/usage.js';
	import { formatCount } from '$lib/formats.js';
	import { MIN_DECODE_TOKENS, MIN_PREFILL_TOKENS } from '$lib/inference-speed.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const speed = $derived(data.speed);
	const overall = $derived(speed.overall);

	const METRICS: { value: SpeedMetric; label: string; description: string }[] = [
		{
			value: 'output',
			label: 'Output',
			description:
				'Generation speed: output tokens per second after the first token. Higher is faster.'
		},
		{
			value: 'input',
			label: 'Input',
			description:
				'Prompt processing speed: uncached prompt tokens ÷ time to first token (network included). Higher is faster.'
		},
		{
			value: 'ttft',
			label: 'First token',
			description: 'Time from sending the request to the first output token. Lower is faster.'
		}
	];
	let metric = $state<SpeedMetric>('output');
	const activeMetric = $derived(METRICS.find((m) => m.value === metric)!);

	/** Provider whose models are shown; '' shows every provider. */
	let providerFilter = $state('');

	const providerName = (p: { providerId: string | null; providerName: string | null }) =>
		p.providerName ?? p.providerId ?? 'Unknown provider';
	const providerColor = (providerId: string | null) =>
		paygColor(providerId ? (data.colorSlots[providerId] ?? null) : null);

	const providerRows = $derived<SpeedRow[]>(
		speed.providers.map((p) => ({
			key: p.providerId ?? '',
			label: providerName(p),
			sublabel: `${p.models} ${p.models === 1 ? 'model' : 'models'}`,
			color: providerColor(p.providerId),
			stats: p
		}))
	);
	const modelRows = $derived<SpeedRow[]>(
		speed.models
			.filter((m) => !providerFilter || (m.providerId ?? '') === providerFilter)
			.map((m) => ({
				key: `${m.providerId ?? ''}/${m.model}`,
				label: m.model,
				// The provider is obvious with one provider, or with one picked in the filter.
				sublabel: speed.providers.length > 1 && !providerFilter ? providerName(m) : undefined,
				color: providerColor(m.providerId),
				stats: m
			}))
	);
	const providerChips = $derived([
		{ id: '', name: 'All providers', color: null as string | null },
		...speed.providers.map((p) => ({
			id: p.providerId ?? '',
			name: providerName(p),
			color: providerColor(p.providerId) as string | null
		}))
	]);
	const filteredProvider = $derived(
		speed.providers.find((p) => (p.providerId ?? '') === providerFilter) ?? null
	);
	/** Every row is compared with the median over all calls (not with the other rows). */
	const reference = $derived(metricValue(overall, metric));
	// Models only: a mix of models per band would show the mix changing, not context.
	const contextRows = $derived<ContextRow[]>(
		speed.models
			.filter((m) => !providerFilter || (m.providerId ?? '') === providerFilter)
			.map((m) => ({
				key: `${m.providerId ?? ''}/${m.model}`,
				label: m.model,
				color: providerColor(m.providerId),
				stats: m
			}))
	);
	// A provider that has since gone from the list resets the filter.
	$effect(() => {
		if (providerFilter && !speed.providers.some((p) => (p.providerId ?? '') === providerFilter))
			providerFilter = '';
	});

	// Numbers for the animated tiles, rounded like formatTps / formatMs.
	const tpsNumber = (tps: number | null | undefined) => ({
		value: tps ?? null,
		format: (tps != null && tps >= 1000
			? 'count'
			: tps != null && tps >= 100
				? 'integer'
				: 'decimal') as NumberFormatKind,
		suffix: ''
	});
	const msNumber = (ms: number | null | undefined) =>
		ms != null && ms >= 1000
			? {
					value: ms / 1000,
					format: (ms < 10_000 ? 'decimal' : 'integer') as NumberFormatKind,
					suffix: ' s',
					unit: ''
				}
			: { value: ms ?? null, format: 'integer' as NumberFormatKind, suffix: ' ms', unit: '' };

	const tiles = $derived([
		{
			label: 'Output speed',
			...tpsNumber(overall.outputTps),
			unit: overall.outputTps == null ? '' : 'tok/s',
			caption: `median of ${formatCount(overall.outputSamples)} replies`,
			title: `${METRICS[0].description} Replies under ${MIN_DECODE_TOKENS} tokens are left out.`
		},
		{
			label: 'Input speed',
			...tpsNumber(overall.inputTps),
			unit: overall.inputTps == null ? '' : 'tok/s',
			caption: `median of ${formatCount(overall.inputSamples)} prompts`,
			title: `${METRICS[1].description} Prompts under ${MIN_PREFILL_TOKENS} uncached tokens are left out.`
		},
		{
			label: 'First token',
			...msNumber(overall.ttftMs),
			caption: `median of ${formatCount(overall.samples)} calls`,
			title: METRICS[2].description
		},
		{
			label: 'Typical context',
			value: overall.contextTokens,
			format: 'count' as const,
			suffix: '',
			unit: overall.contextTokens == null ? '' : 'tokens',
			caption: 'median prompt size per call',
			title:
				'Median input tokens (cached included) per call. The longer the context, the slower most models run.'
		}
	]);
</script>

{#snippet metricToggle()}
	<div class="flex rounded-lg border bg-muted/50 p-0.5" role="radiogroup" aria-label="Compare by">
		{#each METRICS as m (m.value)}
			{@const active = m.value === metric}
			<button
				type="button"
				role="radio"
				aria-checked={active}
				title={m.description}
				onclick={() => (metric = m.value)}
				class="flex h-10 flex-1 items-center justify-center rounded-md px-3 text-xs whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:h-7 {active
					? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border'
					: 'text-muted-foreground hover:text-foreground'}"
			>
				{m.label}
			</button>
		{/each}
	</div>
{/snippet}

<div class="flex flex-col gap-6">
	{#if overall.samples === 0}
		<Card.Root class="rounded-2xl border-border/40">
			<EmptyState
				icon={GaugeIcon}
				title="No timed requests {data.rangeLabel}"
				description="Chatty times every streamed model call from your chats, agent runs and API keys. Speed shows up here after your next few replies."
			/>
		</Card.Root>
	{:else}
		<!-- Two by two on phones, four across from lg. -->
		<div class="grid grid-cols-2 gap-2 sm:gap-4 lg:grid-cols-4">
			{#each tiles as tile (tile.label)}
				<Card.Root class="rounded-2xl border-border/40 py-4 sm:py-6">
					<Card.Content class="flex flex-col gap-1 px-4 sm:px-6">
						<span class="text-xs text-muted-foreground sm:text-sm" title={tile.title}
							>{tile.label}</span
						>
						<span class="text-2xl font-semibold whitespace-nowrap tabular-nums sm:text-3xl">
							<AnimatedNumber
								value={tile.value}
								format={tile.format}
								suffix={tile.suffix}
							/>{#if tile.unit}<span
									class="ml-1 text-xs font-normal text-muted-foreground sm:text-base"
									>{tile.unit}</span
								>{/if}
						</span>
						<span class="text-xs text-muted-foreground"
							>{tile.caption}<span class="hidden sm:inline">, {data.rangeLabel}</span></span
						>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>

		<!-- One control drives every comparison below, so they all read the same way. -->
		<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
			<div class="flex flex-col gap-0.5">
				<h2 class="text-base font-semibold">Compare speed</h2>
				<!-- Two lines reserved, so the toggle doesn't jump between metrics. -->
				<p class="text-sm text-muted-foreground sm:min-h-10" aria-live="polite">
					{activeMetric.description}
				</p>
				<!-- Legend for the marks on every bar. -->
				<p class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
					<span class="inline-flex items-center gap-1.5">
						<span class="h-3.5 w-0.5 rounded-full bg-foreground/70" aria-hidden="true"></span>
						Median of all calls
					</span>
					{#if metric === 'ttft'}
						<span>Shorter bar is better</span>
					{/if}

					<span class="inline-flex items-center gap-1.5">
						<span class="h-2.5 w-5 rounded-full bg-foreground/35" aria-hidden="true"></span>
						Faded: fewer than {FEW_SAMPLES}
						{SAMPLE_NOUN[metric][1]}
					</span>
				</p>
			</div>
			<div class="sm:w-72 sm:shrink-0">{@render metricToggle()}</div>
		</div>

		<section class="flex flex-col gap-3" aria-labelledby="speed-providers-heading">
			<Card.Root class="gap-2 rounded-2xl border-border/40">
				<Card.Header>
					<Card.Title id="speed-providers-heading" class="text-sm font-medium"
						>By provider</Card.Title
					>
					<Card.Description>All of a provider's calls together, best first.</Card.Description>
				</Card.Header>
				<Card.Content>
					<SpeedBars
						rows={providerRows}
						{metric}
						{reference}
						label="Providers by {activeMetric.label}"
					/>
				</Card.Content>
			</Card.Root>
		</section>

		<section class="flex flex-col gap-3" aria-labelledby="speed-models-heading">
			<Card.Root class="gap-2 rounded-2xl border-border/40">
				<Card.Header>
					<Card.Title id="speed-models-heading" class="text-sm font-medium">By model</Card.Title>
					<Card.Description
						>Each model on its own, best first, with the context it usually ran at.</Card.Description
					>
				</Card.Header>
				<Card.Content class="flex flex-col gap-3">
					{#if speed.providers.length > 1}
						<div class="flex flex-wrap gap-1.5" role="group" aria-label="Filter models by provider">
							{#each providerChips as chip (chip.id)}
								{@const active = providerFilter === chip.id}
								<button
									type="button"
									aria-pressed={active}
									onclick={() => (providerFilter = chip.id)}
									class="inline-flex h-10 items-center gap-1.5 rounded-full border px-3 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:h-7 {active
										? 'border-foreground/40 bg-accent font-medium text-accent-foreground'
										: 'border-border/60 text-muted-foreground hover:text-foreground'}"
								>
									{#if chip.color}
										<span
											class="size-2 rounded-full"
											style:background-color={chip.color}
											aria-hidden="true"
										></span>
									{/if}
									{chip.name}
								</button>
							{/each}
						</div>
					{/if}
					<SpeedBars rows={modelRows} {metric} {reference} label="Models by {activeMetric.label}" />
				</Card.Content>
			</Card.Root>
		</section>

		<section class="flex flex-col gap-3" aria-labelledby="speed-context-heading">
			<Card.Root class="gap-2 rounded-2xl border-border/40">
				<Card.Header>
					<Card.Title id="speed-context-heading" class="text-sm font-medium"
						>By context size</Card.Title
					>
					<Card.Description>
						The same figure split by how many input tokens each call carried{filteredProvider
							? `, for ${providerName(filteredProvider)} models`
							: ''}. Long context slows most models down, small local ones the most. "Short → long"
						compares the smallest and largest context with enough calls.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<SpeedByContext rows={contextRows} {metric} />
				</Card.Content>
			</Card.Root>
		</section>

		<div class="flex flex-col gap-1.5 text-xs text-muted-foreground">
			<h2 class="font-medium text-foreground/80">How this is measured</h2>
			<ul class="flex list-disc flex-col gap-1 pl-4">
				<li>
					Chatty times each streamed model call itself, leaving tool runs out. Network time counts
					toward time to first token, which for short prompts is mostly network.
				</li>
				<li>
					Input speed skips cached input and prompts under {MIN_PREFILL_TOKENS} tokens; output speed skips
					replies under {MIN_DECODE_TOKENS} tokens. A provider that reuses a cached prompt without reporting
					it makes input speed read high.
				</li>
				<li>
					Context is the call's input size, cached tokens included. Coding environments (T3 Code)
					don't report timings yet, so they aren't included.
				</li>
			</ul>
		</div>
	{/if}
</div>
