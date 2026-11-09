<script lang="ts">
	import CalculatorIcon from '@lucide/svelte/icons/calculator';
	import ArrowRightLeftIcon from '@lucide/svelte/icons/arrow-right-left';
	import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import CheckIcon from '@lucide/svelte/icons/check';
	import type { Component } from 'svelte';
	import WidgetCard from './widget-card.svelte';
	import {
		capitalize,
		formatScaled,
		formatNumber,
		parseCalc,
		prettyExpression,
		prettyUnit,
		unitIsFlush,
		type CalcPayload,
		type Formatted,
		type Quantity
	} from './calc-payload.js';

	let { code, isIncomplete }: { code: string; isIncomplete: boolean } = $props();

	const data = $derived<CalcPayload | null>(isIncomplete ? null : parseCalc(code));

	type Kind = CalcPayload['kind'];
	const KIND: Record<Kind, { icon: Component; light: string; dark: string }> = {
		calculate: {
			icon: CalculatorIcon,
			light:
				'radial-gradient(70% 90% at 100% 0%, oklch(0.62 0.16 300 / 0.55), transparent 65%), linear-gradient(150deg, oklch(0.5 0.17 272), oklch(0.39 0.16 280))',
			dark: 'radial-gradient(70% 90% at 100% 0%, oklch(0.5 0.14 300 / 0.5), transparent 65%), linear-gradient(150deg, oklch(0.4 0.14 272), oklch(0.29 0.11 280))'
		},
		convert: {
			icon: ArrowRightLeftIcon,
			light:
				'radial-gradient(70% 90% at 100% 0%, oklch(0.66 0.11 165 / 0.55), transparent 65%), linear-gradient(150deg, oklch(0.5 0.1 200), oklch(0.39 0.085 225))',
			dark: 'radial-gradient(70% 90% at 100% 0%, oklch(0.52 0.1 165 / 0.45), transparent 65%), linear-gradient(150deg, oklch(0.4 0.085 200), oklch(0.29 0.065 225))'
		},
		statistics: {
			icon: ChartColumnIcon,
			light:
				'radial-gradient(70% 90% at 100% 0%, oklch(0.62 0.15 350 / 0.45), transparent 65%), linear-gradient(150deg, oklch(0.47 0.15 305), oklch(0.36 0.12 290))',
			dark: 'radial-gradient(70% 90% at 100% 0%, oklch(0.5 0.13 350 / 0.4), transparent 65%), linear-gradient(150deg, oklch(0.37 0.12 305), oklch(0.27 0.09 290))'
		}
	};

	const NBSP = String.fromCharCode(0xa0);

	/** Value + unit as one string, with flush units (°C) and a no-break space otherwise. */
	function withUnit(value: string, unit: string): string {
		if (!unit) return value;
		return unitIsFlush(unit) ? `${value}${unit}` : `${value}${NBSP}${unit}`;
	}

	function quantityText(q: Quantity, sig: number): string {
		return withUnit(formatNumber(q.value, sig).text, prettyUnit(q.unit));
	}

	/** Hero font size steps down as the answer gets longer, so it never overflows. */
	function heroSize(text: string): string {
		const n = text.length;
		if (n <= 9) return 'text-6xl @md:text-7xl';
		if (n <= 13) return 'text-5xl @md:text-6xl';
		if (n <= 18) return 'text-4xl @md:text-5xl';
		if (n <= 26) return 'text-3xl @md:text-4xl';
		return 'text-2xl @md:text-3xl';
	}

	// ── Copy ────────────────────────────────────────────────────────────────
	let copied = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	async function copy(key: string, value: string) {
		try {
			await navigator.clipboard.writeText(value);
			copied = key;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = null), 1600);
		} catch {
			// Clipboard unavailable (insecure context or denied) — nothing to do.
		}
	}

	// Long expressions scroll inside a capped box; fade the bottom edge while there's more below.
	let exprEl = $state<HTMLElement | null>(null);
	let exprOverflows = $state(false);
	$effect(() => {
		const el = exprEl;
		if (!el) return;
		const check = () => {
			exprOverflows = el.scrollHeight - el.scrollTop - el.clientHeight > 2;
		};
		check();
		const ro = new ResizeObserver(() => requestAnimationFrame(check));
		ro.observe(el);
		el.addEventListener('scroll', check, { passive: true });
		return () => {
			ro.disconnect();
			el.removeEventListener('scroll', check);
		};
	});

	// ── Statistics distribution strip ───────────────────────────────────────
	/** One dot column per ~9px of strip width, so dots never merge on narrow cards. */
	let stripWidth = $state(0);
	const dotCols = $derived(
		stripWidth > 0 ? Math.max(12, Math.min(48, Math.floor(stripWidth / 9))) : 36
	);
	const MAX_DOT_ROWS = 6;

	type Strip =
		| { mode: 'dots'; dots: Array<{ x: number; row: number; v: number }>; rows: number }
		| { mode: 'bars'; bars: number[] };

	const stats = $derived(data?.kind === 'statistics' ? data : null);
	const flat = $derived(stats ? stats.max === stats.min : false);

	/** Position of a value on the strip's shared axis, in %. */
	function axis(v: number): number {
		if (!stats || flat) return 50;
		return ((v - stats.min) / (stats.max - stats.min)) * 100;
	}

	function binValues(values: number[], bins: number): number[] {
		const counts = new Array<number>(bins).fill(0);
		for (const v of values) {
			const i = flat ? Math.floor(bins / 2) : Math.floor((axis(v) / 100) * bins);
			counts[Math.min(bins - 1, i)]++;
		}
		return counts;
	}

	const strip = $derived.by((): Strip | null => {
		if (!stats) return null;
		if (stats.values) {
			const stacks = new Array<number>(dotCols).fill(0);
			const dots = stats.values.map((v) => {
				const col = flat ? Math.floor(dotCols / 2) : Math.round((axis(v) / 100) * (dotCols - 1));
				const row = stacks[col]++;
				return { x: flat ? 50 : (col / (dotCols - 1)) * 100, row, v };
			});
			const rows = Math.max(...stacks);
			if (rows <= MAX_DOT_ROWS) return { mode: 'dots', dots, rows };
			return { mode: 'bars', bars: binValues(stats.values, 24) };
		}
		if (stats.histogram) return { mode: 'bars', bars: stats.histogram };
		return null;
	});

	const statsSummary = $derived.by(() => {
		if (!stats) return '';
		const parts = [`n = ${stats.count}`, `mean = ${stats.mean}`];
		if (stats.median !== null) parts.push(`median = ${stats.median}`);
		parts.push(`min = ${stats.min}`, `max = ${stats.max}`);
		if (stats.stdev !== null) parts.push(`stdev = ${stats.stdev}`);
		return parts.join(', ');
	});

	/** Every statistic shares one precision, set by the dataset's largest magnitude. */
	function fmt(v: number): string {
		if (!stats) return '';
		return formatScaled(v, Math.max(Math.abs(stats.min), Math.abs(stats.max)));
	}

	const countLabel = $derived(
		stats
			? `${new Intl.NumberFormat().format(stats.count)} ${stats.count === 1 ? 'value' : 'values'}`
			: ''
	);
</script>

{#snippet copyButton(key: string, value: string, label: string)}
	<button
		type="button"
		class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white/90 ring-1 ring-white/20 transition-colors ring-inset hover:bg-white/20 hover:text-white focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
		aria-label={copied === key ? 'Copied' : label}
		title={copied === key ? 'Copied' : label}
		onclick={() => copy(key, value)}
	>
		{#if copied === key}
			<CheckIcon class="size-4" aria-hidden="true" />
		{:else}
			<CopyIcon class="size-4" aria-hidden="true" />
		{/if}
	</button>
{/snippet}

{#snippet eyebrow(icon: Component, label: string)}
	{@const Icon = icon}
	<span
		class="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold tracking-wider text-white/85 uppercase"
	>
		<Icon class="size-3.5 shrink-0" aria-hidden="true" />
		<span class="truncate">{label}</span>
	</span>
{/snippet}

{#snippet tile(label: string, value: string, sub?: string, full?: string)}
	<div
		class="flex min-w-0 flex-col gap-0.5 rounded-xl bg-white/10 px-3 py-2.5 ring-1 ring-white/20 backdrop-blur-md ring-inset"
	>
		<span class="truncate text-[11px] font-semibold tracking-wide text-white/85 uppercase"
			>{label}</span
		>
		<span
			class="text-base font-semibold [overflow-wrap:anywhere] text-white tabular-nums"
			title={full ?? value}>{value}</span
		>
		{#if sub}
			<span class="truncate text-xs text-white/75 tabular-nums" title={sub}>{sub}</span>
		{/if}
	</div>
{/snippet}

{#snippet hero(f: Formatted, unit = '', full?: string)}
	{@const label = withUnit(
		f.sci ? `${f.sci.mantissa} times 10 to the ${f.sci.exponent}` : f.text,
		unit
	)}
	<p
		class="leading-[1.05] font-light tracking-tight [overflow-wrap:anywhere] tabular-nums [text-shadow:0_2px_12px_rgb(0_0_0/0.18)] {heroSize(
			withUnit(f.text, unit)
		)}"
		title={full}
	>
		<span class="sr-only">{label}</span>
		<span aria-hidden="true"
			>{#if f.sci}{f.sci.mantissa}<span class="mx-[0.15em] text-[0.7em] text-white/70">×</span
				>10<sup class="ml-[0.05em] align-[0.75em] text-[0.45em] font-normal">{f.sci.power}</sup
				>{:else}{f.text}{/if}{#if unit}{unitIsFlush(unit) ? '' : NBSP}<span
					class="text-[0.6em] font-normal text-white/80 {unitIsFlush(unit) ? 'ml-[0.08em]' : ''}"
					>{unit}</span
				>{/if}</span
		>
	</p>
{/snippet}

<WidgetCard
	icon={data ? KIND[data.kind].icon : CalculatorIcon}
	status={data ? 'ready' : isIncomplete ? 'loading' : 'error'}
	loadingLabel="Calculating…"
	errorLabel="Could not render this result"
	skeletonClass="h-40 bg-linear-to-br from-indigo-500/15 to-transparent"
	raw={code}
	divided={false}
	class="@container"
>
	<span class="sr-only" aria-live="polite">{copied ? 'Copied to clipboard' : ''}</span>
	{#if data}
		{@const k = KIND[data.kind]}
		<div
			class="relative isolate overflow-hidden text-white [background:var(--calc-bg-light)] dark:[background:var(--calc-bg-dark)]"
			style="--calc-bg-light: {k.light}; --calc-bg-dark: {k.dark}"
		>
			{#if data.kind !== 'statistics'}
				{@const Mark = k.icon}
				<Mark
					class="pointer-events-none absolute -right-6 -bottom-14 -z-10 hidden size-44 text-white/[0.07] @md:block"
					stroke-width={1.25}
					aria-hidden="true"
				/>
			{/if}
			{#if data.kind === 'calculate'}
				<div class="flex flex-col gap-2 px-5 pt-4 pb-6">
					<div class="flex items-center justify-between gap-3">
						{@render eyebrow(CalculatorIcon, 'Calculation')}
						{@render copyButton('result', String(data.result), 'Copy result')}
					</div>
					{#if data.expression}
						<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
						<p
							bind:this={exprEl}
							tabindex={exprOverflows ? 0 : undefined}
							role={exprOverflows ? 'region' : undefined}
							aria-label={exprOverflows ? 'Expression' : undefined}
							class="max-h-20 overflow-y-auto font-mono text-sm @md:max-h-28 {exprOverflows
								? '[mask-image:linear-gradient(to_bottom,black_65%,transparent)]'
								: ''} rounded-sm leading-relaxed [overflow-wrap:anywhere] text-white/85 focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:outline-none"
						>
							<span class="sr-only">Expression: </span>{prettyExpression(data.expression)}
						</p>
					{/if}
					<div class="flex min-w-0 items-baseline gap-2">
						<span class="text-3xl font-light text-white/60 @md:text-4xl" aria-hidden="true">=</span>
						{@render hero(formatNumber(data.result, 12))}
					</div>
				</div>
			{:else if data.kind === 'convert'}
				{@const first = data.to[0]}
				{@const rest = data.to.slice(1)}
				{@const fromText =
					data.from.value !== undefined
						? withUnit(formatNumber(data.from.value, 10).text, prettyUnit(data.from.unit ?? ''))
						: (data.from.expression ?? '')}
				<div class="flex flex-col gap-1 px-5 pt-4 pb-5">
					<div class="flex items-center justify-between gap-3">
						{@render eyebrow(
							ArrowRightLeftIcon,
							data.measure ? `${capitalize(data.measure)} conversion` : 'Unit conversion'
						)}
						{@render copyButton(
							'result',
							withUnit(String(first.value), prettyUnit(first.unit)),
							'Copy result'
						)}
					</div>
					{#if fromText}
						<p class="mt-1 text-lg [overflow-wrap:anywhere] text-white/85 tabular-nums">
							{fromText}{#if data.from.name}<span class="sr-only"> ({data.from.name})</span>{/if}
							<span class="text-white/60" aria-hidden="true">=</span>
						</p>
					{/if}
					{@render hero(formatNumber(first.value, 4), prettyUnit(first.unit), String(first.value))}
					{#if first.name}
						<p class="text-sm text-white/80">{capitalize(first.name)}</p>
					{/if}
					{#if rest.length > 0}
						<ul
							class="mt-4 grid gap-2 {rest.length === 3
								? 'grid-cols-3'
								: 'grid-cols-2 @xl:grid-cols-3'}"
							aria-label="Other units"
						>
							{#each rest as q, i (i)}
								<li class="contents">
									{@render tile(
										capitalize(q.name ?? prettyUnit(q.unit)),
										quantityText(q, 4),
										undefined,
										withUnit(String(q.value), prettyUnit(q.unit))
									)}
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{:else if stats}
				{@const single = flat}
				{@const close =
					stats.median !== null && Math.abs(axis(stats.mean) - axis(stats.median)) < 2}
				<div class="flex flex-col px-5 pt-4 pb-5">
					<div class="flex items-center justify-between gap-3">
						{@render eyebrow(ChartColumnIcon, `Statistics · ${countLabel}`)}
						{@render copyButton('result', statsSummary, 'Copy summary')}
					</div>
					<div class="mt-2 flex min-w-0 flex-wrap items-end gap-x-3 gap-y-1">
						<div class="flex min-w-0 flex-col">
							<span class="text-xs font-medium text-white/80"
								>{stats.count === 1 ? 'Value' : flat ? 'Every value' : 'Mean'}</span
							>
							{@render hero({ text: fmt(stats.mean) })}
						</div>
						{#if stats.stdev !== null && !single}
							<span
								class="pb-1.5 text-lg font-light text-white/80 tabular-nums"
								title="{stats.sample ? 'Sample' : 'Population'} standard deviation"
							>
								<span aria-hidden="true">±</span><span class="sr-only"
									>{stats.sample ? 'sample' : 'population'} standard deviation</span
								>
								{fmt(stats.stdev)}
								<span class="ml-0.5 text-xs font-medium text-white/65" aria-hidden="true">SD</span>
							</span>
						{/if}
					</div>

					<!-- Distribution: every value (or a histogram) on one axis, with mean and median marked -->
					{#if strip && !single}
						<div class="mt-3" aria-hidden="true">
							<div class="mb-1.5 flex justify-end gap-3 text-[11px] font-medium text-white/80">
								<span class="flex items-center gap-1.5"
									><span class="h-3 w-[2px] rounded-full bg-amber-300"></span>{close
										? 'Mean ≈ median'
										: 'Mean'}</span
								>
								{#if stats.median !== null && !close}
									<span class="flex items-center gap-1.5"
										><span class="h-3 w-[2px] rounded-full bg-sky-200"></span>Median</span
									>
								{/if}
							</div>
							<div class="relative mx-1 h-14" bind:clientWidth={stripWidth}>
								{#if strip.mode === 'dots'}
									{#each strip.dots as d, i (i)}
										<span
											class="absolute z-10 size-[7px] -translate-x-1/2 rounded-full bg-white/90 shadow-[0_0_0_1px_rgb(0_0_0/0.08)]"
											style="left: {d.x}%; bottom: {d.row * 9}px"
										></span>
									{/each}
								{:else}
									{@const peak = Math.max(...strip.bars)}
									<div class="absolute inset-0 flex items-end gap-px">
										{#each strip.bars as n, i (i)}
											<span
												class="flex-1 rounded-t-[2px] {n > 0 ? 'bg-white/75' : ''}"
												style="height: {n > 0 ? Math.max(6, (n / peak) * 100) : 0}%"
											></span>
										{/each}
									</div>
								{/if}
								{#if stats.median !== null && !close}
									<span
										class="absolute -top-1 -bottom-1 z-20 w-[2px] -translate-x-1/2 rounded-full bg-sky-200 shadow-[0_0_0_1px_rgb(0_0_0/0.18)]"
										style="left: {axis(stats.median)}%"
									></span>
								{/if}
								<span
									class="absolute -top-1 -bottom-1 z-20 w-[2px] -translate-x-1/2 rounded-full bg-amber-300 shadow-[0_0_0_1px_rgb(0_0_0/0.18)]"
									style="left: {axis(stats.mean)}%"
								></span>
							</div>
							<div class="mx-1 h-px bg-white/35"></div>
							<div
								class="mt-1.5 flex items-center justify-between gap-3 text-xs text-white/80 tabular-nums"
							>
								<span><span class="sr-only">Minimum </span>{fmt(stats.min)}</span>
								<span><span class="sr-only">Maximum </span>{fmt(stats.max)}</span>
							</div>
						</div>
					{/if}

					{#if single}
						<p class="mt-3 text-sm text-white/80">
							{stats.count === 1
								? 'Spread and distribution need at least two values.'
								: `All ${countLabel} are equal, so there is no spread to show.`}
						</p>
					{:else}
						<div class="mt-4 grid grid-cols-2 gap-2 @xl:grid-cols-4">
							{@render tile('Median', stats.median !== null ? fmt(stats.median) : '—')}
							{@render tile(
								'Range',
								fmt(stats.max - stats.min),
								`${fmt(stats.min)} – ${fmt(stats.max)}`
							)}
							{@render tile(
								'IQR',
								stats.q1 !== null && stats.q3 !== null ? fmt(stats.q3 - stats.q1) : '—',
								stats.q1 !== null && stats.q3 !== null
									? `${fmt(stats.q1)} – ${fmt(stats.q3)}`
									: undefined
							)}
							{@render tile('Sum', stats.sum !== null ? fmt(stats.sum) : '—')}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</WidgetCard>
