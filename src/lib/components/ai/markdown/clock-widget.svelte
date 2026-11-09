<script lang="ts">
	import ClockIcon from '@lucide/svelte/icons/clock';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import ArrowRightLeftIcon from '@lucide/svelte/icons/arrow-right-left';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunriseIcon from '@lucide/svelte/icons/sunrise';
	import SunsetIcon from '@lucide/svelte/icons/sunset';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { Component } from 'svelte';
	import WidgetCard from './widget-card.svelte';
	import {
		dateLabel,
		dayDelta,
		formatDiff,
		formatOffset,
		isValidZone,
		phaseOf,
		timeParts,
		viewerZone,
		zoneLabel,
		zoneTime,
		type Phase
	} from './clock-time.js';

	type ZoneInput = { label?: string; tz?: string } | string;
	type Payload = { title?: string; at?: string; convert?: boolean; zones?: ZoneInput[] };

	type Props = {
		code: string;
		isIncomplete: boolean;
		/** Override for the viewer's zone (tests); defaults to the browser's. */
		viewerTimeZone?: string;
	};

	let { code, isIncomplete, viewerTimeZone }: Props = $props();

	const MAX_ZONES = 8;

	const data = $derived.by(() => {
		if (isIncomplete) return null;
		try {
			const parsed = JSON.parse(code) as Payload;
			if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.zones)) {
				return null;
			}
			const zones = parsed.zones
				.map((z) => (typeof z === 'string' ? { tz: z } : z))
				.filter((z): z is { label?: string; tz?: string } => typeof z === 'object' && z !== null)
				.map((z) => {
					const tz = typeof z.tz === 'string' ? z.tz.trim() : '';
					const label = typeof z.label === 'string' && z.label.trim() ? z.label.trim() : '';
					return { tz, label: label || (tz ? zoneLabel(tz) : 'Unknown') };
				})
				.slice(0, MAX_ZONES);
			if (zones.length === 0) return null;
			let at: number | null = null;
			if (parsed.at !== undefined && parsed.at !== null) {
				at = Date.parse(String(parsed.at));
				if (Number.isNaN(at)) return null;
			}
			return {
				title: typeof parsed.title === 'string' ? parsed.title : null,
				at,
				convert: parsed.convert === true,
				zones
			};
		} catch {
			return null;
		}
	});

	// Live mode ticks on each minute boundary, re-aligning after each tick so
	// timer drift (sleep, background tabs) never leaves a stale minute.
	let now = $state(Date.now());
	const live = $derived(data !== null && data.at === null);
	$effect(() => {
		if (!live) return;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const tick = () => {
			const t = Date.now(); // local: reading `now` here would make it an effect dependency
			now = t;
			clearTimeout(timeout);
			timeout = setTimeout(tick, 60_000 - (t % 60_000) + 50);
		};
		const onVisible = () => {
			if (document.visibilityState === 'visible') tick();
		};
		tick();
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearTimeout(timeout);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	const instant = $derived(data?.at ?? now);
	const viewer = $derived(
		viewerTimeZone && isValidZone(viewerTimeZone) ? viewerTimeZone : viewerZone()
	);
	const viewerTime = $derived(zoneTime(instant, viewer));
	// A conversion reads "this moment in the first city is … in the others".
	// An unknown source zone can't anchor a conversion; show a plain world clock instead.
	const conversion = $derived(
		data !== null && data.convert && data.zones.length >= 2 && isValidZone(data.zones[0].tz)
	);

	type Row = {
		label: string;
		tz: string;
		valid: boolean;
		hour: number;
		minute: number;
		phase: Phase;
		time: string;
		period: string;
		date: string;
		relative: string;
		offset: string;
		diff: string;
		/** City the diff is measured from; "you" for the viewer. */
		diffRef: string;
		spoken: string;
	};

	const rows = $derived.by((): Row[] => {
		if (!data) return [];
		const source = conversion ? zoneTime(instant, data.zones[0].tz) : null;
		return data.zones.map((z, i) => {
			const zt = zoneTime(instant, z.tz);
			if (!zt) {
				return {
					label: z.label,
					tz: z.tz,
					valid: false,
					hour: 0,
					minute: 0,
					phase: 'day',
					time: '',
					period: '',
					date: '',
					relative: '',
					offset: '',
					diff: '',
					diffRef: '',
					spoken: `${z.label}: unknown time zone`
				};
			}
			const { time, period } = timeParts(instant, z.tz);
			// Conversion targets compare against the source city; everything else against the viewer.
			const ref = conversion && i > 0 && source ? source : viewerTime;
			const refName = conversion && i > 0 && source ? data.zones[0].label : 'you';
			let relative = '';
			let diff = '';
			let diffRef = '';
			// The conversion's source tile states the question; it needs no comparison.
			if (ref && !(conversion && i === 0)) {
				const days = dayDelta(ref.dateKey, zt.dateKey);
				if (days !== 0) {
					if (conversion) relative = days > 0 ? 'Next day' : 'Previous day';
					else relative = days > 0 ? 'Tomorrow' : 'Yesterday';
				}
				const d = zt.offset - ref.offset;
				if (d !== 0) {
					diff = formatDiff(d);
					diffRef = refName;
				} else if (refName === 'you') diff = z.tz === viewer ? 'Your time zone' : 'Same as you';
				else diff = `Same as ${refName}`;
			}
			const date = dateLabel(instant, z.tz);
			return {
				label: z.label,
				tz: z.tz,
				valid: true,
				hour: zt.hour,
				minute: zt.minute,
				phase: phaseOf(zt.hour, zt.minute),
				time,
				period,
				date,
				relative,
				offset: formatOffset(zt.offset),
				diff,
				diffRef,
				spoken: `${z.label}: ${time} ${period} (${PHASE[phaseOf(zt.hour, zt.minute)].label.toLowerCase()}), ${date}${relative ? ` (${relative})` : ''}, ${formatOffset(zt.offset)}${diff ? `, ${diff}${diffRef ? ` from ${diffRef}` : ''}` : ''}`
			};
		});
	});

	// Star field for night skies; `seed` shifts it so stacked night rows don't look stamped.
	const STAR_POINTS: Array<[x: number, y: number, size: number, alpha: number]> = [
		[12, 22, 1.2, 0.75],
		[28, 70, 1, 0.5],
		[46, 18, 1.4, 0.6],
		[63, 56, 1, 0.45],
		[78, 30, 1.2, 0.65],
		[90, 78, 1, 0.45]
	];
	function stars(seed: number): string {
		return STAR_POINTS.map(([x, y, size, alpha]) => {
			const sx = (x + seed * 37) % 100;
			const sy = (y + seed * 23) % 100;
			return `radial-gradient(${size}px ${size}px at ${sx}% ${sy}%, rgb(255 255 255 / ${alpha}), transparent)`;
		}).join(', ');
	}

	// Sky per light phase, in the spirit of the weather widget. Every stop stays
	// dark enough (L ≤ ~0.6) for white text at small sizes, in both app themes.
	const SKY: Record<Exclude<Phase, 'night'>, string> = {
		day: 'radial-gradient(40% 70% at 72% 0%, oklch(0.97 0.05 85 / 0.24), transparent 70%), linear-gradient(160deg, oklch(0.54 0.15 248), oklch(0.43 0.16 262))',
		dawn: 'radial-gradient(60% 90% at 10% 100%, oklch(0.9 0.08 70 / 0.28), transparent 70%), linear-gradient(170deg, oklch(0.52 0.08 240), oklch(0.53 0.08 10) 60%, oklch(0.56 0.1 60))',
		dusk: 'radial-gradient(60% 90% at 90% 100%, oklch(0.75 0.17 50 / 0.35), transparent 70%), linear-gradient(165deg, oklch(0.3 0.1 300), oklch(0.47 0.16 30))'
	};
	const NIGHT =
		'radial-gradient(70% 90% at 90% 0%, oklch(0.45 0.08 270 / 0.55), transparent 60%), linear-gradient(160deg, oklch(0.3 0.08 270), oklch(0.2 0.06 275))';

	function sky(phase: Phase, seed = 0): string {
		return phase === 'night' ? `${stars(seed)}, ${NIGHT}` : SKY[phase];
	}

	const PHASE: Record<Phase, { icon: Component; label: string }> = {
		dawn: { icon: SunriseIcon, label: 'Morning' },
		day: { icon: SunIcon, label: 'Daytime' },
		dusk: { icon: SunsetIcon, label: 'Evening' },
		night: { icon: MoonIcon, label: 'Night' }
	};

	const single = $derived(rows.length === 1);
	const title = $derived(
		data?.title ||
			(conversion ? 'Time conversion' : single ? `Time in ${rows[0].label}` : 'World clock')
	);
	const subtitle = $derived.by(() => {
		if (!data || !viewerTime) return null;
		const { time, period } = timeParts(instant, viewer);
		const yours = `${time}${period ? ` ${period}` : ''}`;
		if (conversion) {
			const [src, ...targets] = rows;
			const to = targets.length === 1 ? targets[0].label : `${targets.length} cities`;
			const at = src.valid ? `${src.time}${src.period ? ` ${src.period}` : ''} ` : '';
			return `${dateLabel(instant, src.valid ? src.tz : viewer)} · ${at}${src.label} → ${to}`;
		}
		return `${dateLabel(instant, viewer)} · ${yours} your time`;
	});
</script>

{#snippet dial(hour: number, minute: number, cls: string, compact = false)}
	<svg viewBox="0 0 100 100" class={cls} aria-hidden="true">
		<circle
			cx="50"
			cy="50"
			r="47"
			fill="rgb(255 255 255 / {compact ? 0.18 : 0.1})"
			stroke="rgb(255 255 255 / 0.35)"
			stroke-width="2"
		/>
		{#each compact ? [0, 3, 6, 9] : Array.from({ length: 12 }, (_, i) => i) as i (i)}
			<line
				x1="50"
				y1={i % 3 === 0 ? 9 : 11}
				x2="50"
				y2="16"
				stroke="white"
				stroke-opacity={i % 3 === 0 ? 0.9 : 0.5}
				stroke-width={i % 3 === 0 ? 3 : 2}
				stroke-linecap="round"
				transform="rotate({i * 30} 50 50)"
			/>
		{/each}
		<line
			x1="50"
			y1="50"
			x2="50"
			y2={compact ? 32 : 28}
			stroke="white"
			stroke-width={compact ? 7 : 5}
			stroke-linecap="round"
			transform="rotate({((hour % 12) + minute / 60) * 30} 50 50)"
		/>
		<line
			x1="50"
			y1="50"
			x2="50"
			y2="17"
			stroke="white"
			stroke-opacity={compact ? 0.75 : 0.9}
			stroke-width={compact ? 4 : 3}
			stroke-linecap="round"
			transform="rotate({minute * 6} 50 50)"
		/>
		<circle cx="50" cy="50" r="4" fill="white" />
	</svg>
{/snippet}

{#snippet badRow(row: Row)}
	<div
		class="flex min-w-0 items-center gap-3 rounded-xl bg-muted/50 px-4 py-3 ring-1 ring-border/60 ring-inset"
		role="group"
		aria-label={row.spoken}
	>
		<TriangleAlertIcon
			class="size-4 shrink-0 text-amber-600 dark:text-amber-400"
			aria-hidden="true"
		/>
		<div class="flex min-w-0 flex-col">
			<span class="truncate text-sm font-medium">{row.label}</span>
			<span class="truncate text-xs text-muted-foreground"
				>Unknown time zone{row.tz ? ` “${row.tz}”` : ''}</span
			>
		</div>
	</div>
{/snippet}

{#snippet tile(row: Row, seed: number, eyebrow?: string, hideRef = false)}
	{@const P = PHASE[row.phase]}
	<div
		class="relative isolate flex min-w-0 items-center gap-3 overflow-hidden rounded-xl px-4 py-3 text-white"
		style="background: {sky(row.phase, seed)}"
		role="group"
		aria-label={row.spoken}
	>
		{@render dial(
			row.hour,
			row.minute,
			'hidden size-11 shrink-0 drop-shadow-[0_4px_10px_rgb(0_0_0/0.2)] @md:block',
			true
		)}
		<div
			class="flex min-w-0 flex-1 flex-col gap-0.5 [text-shadow:0_1px_2px_rgb(0_0_0/0.25)]"
			aria-hidden="true"
		>
			{#if eyebrow}
				<span class="text-[11px] font-semibold tracking-wide text-white/90 uppercase @max-md:hidden"
					>{eyebrow}</span
				>
			{/if}
			<span class="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
				<span class="truncate" title={row.tz}>{row.label}</span>
				<span class="shrink-0" title={P.label}><P.icon class="size-4 opacity-90" /></span>
			</span>
			{#if row.relative}
				<span class="text-xs text-white/90"
					>{`${row.date} · `}<span class="font-semibold">{row.relative}</span></span
				>
			{/if}
			<span class="truncate text-xs text-white/90 tabular-nums"
				>{row.diff
					? `${row.offset} · ${row.diff}`
					: row.offset}{#if row.diffRef === 'you' || (row.diffRef && !hideRef)}<span
						class={row.diffRef === 'you' ? '' : '@max-md:hidden'}>{` from ${row.diffRef}`}</span
					>{/if}</span
			>
		</div>
		<div
			class="flex shrink-0 items-baseline gap-1 [text-shadow:0_2px_12px_rgb(0_0_0/0.18)]"
			aria-hidden="true"
		>
			<span class="text-3xl leading-none font-light tracking-tight tabular-nums @md:text-4xl"
				>{row.time}</span
			>
			{#if row.period}
				<span class="text-sm font-medium text-white/90">{row.period}</span>
			{/if}
		</div>
	</div>
{/snippet}

{#snippet chips(row: Row)}
	<div class="flex flex-wrap gap-1.5 text-xs font-medium tabular-nums">
		<span class="rounded-full bg-white/15 px-2.5 py-1 ring-1 ring-white/20 ring-inset"
			>{row.offset}</span
		>
		{#if row.diff}
			<span class="rounded-full bg-white/15 px-2.5 py-1 ring-1 ring-white/20 ring-inset"
				>{row.diff}{row.diffRef ? ` from ${row.diffRef}` : ''}</span
			>
		{/if}
	</div>
{/snippet}

<WidgetCard
	icon={single ? ClockIcon : conversion ? ArrowRightLeftIcon : GlobeIcon}
	{title}
	{subtitle}
	status={data ? 'ready' : isIncomplete ? 'loading' : 'error'}
	loadingLabel="Loading clock…"
	errorLabel="Could not render clock"
	skeletonClass="h-40 bg-linear-to-b from-sky-500/15 to-transparent"
	raw={code}
	divided={false}
	class="@container"
>
	{#snippet meta()}
		{#if live}
			<span class="flex items-center gap-1.5">
				<span class="size-1.5 rounded-full bg-emerald-500" aria-hidden="true"></span>
				Live<span class="sr-only">, updates every minute</span>
			</span>
		{/if}
	{/snippet}

	{#if data}
		{#if single}
			{@const row = rows[0]}
			{#if !row.valid}
				<div class="px-3 pb-3">{@render badRow(row)}</div>
			{:else}
				{@const P = PHASE[row.phase]}
				<div
					class="relative isolate flex items-center gap-4 overflow-hidden px-5 py-5 text-white @sm:gap-5 @md:gap-7 @md:px-6 @lg:justify-center @lg:gap-10"
					style="background: {sky(row.phase)}"
					role="group"
					aria-label={row.spoken}
				>
					{@render dial(
						row.hour,
						row.minute,
						'size-16 shrink-0 drop-shadow-[0_6px_18px_rgb(0_0_0/0.25)] @[20rem]:size-20 @sm:size-24 @md:size-32 @lg:size-40'
					)}
					<div class="flex min-w-0 flex-1 flex-col @lg:flex-none" aria-hidden="true">
						<span class="flex min-w-0 items-center gap-1.5 text-base font-semibold">
							<span class="truncate" title={row.tz}>{row.label}</span>
							<span class="shrink-0" title={P.label}><P.icon class="size-4 opacity-90" /></span>
						</span>
						<div class="mt-1 flex items-baseline gap-1.5 [text-shadow:0_2px_12px_rgb(0_0_0/0.18)]">
							<span
								class="text-5xl leading-none font-light tracking-tighter tabular-nums @sm:text-6xl @md:text-7xl"
								>{row.time}</span
							>
							{#if row.period}
								<span class="text-lg font-medium text-white/90 @md:text-xl">{row.period}</span>
							{/if}
						</div>
						{#if row.relative}
							<span class="mt-2 truncate text-sm text-white/90"
								>{`${row.date} · `}<span class="font-semibold">{row.relative}</span></span
							>
						{/if}
						<div class="mt-3">{@render chips(row)}</div>
					</div>
				</div>
			{/if}
		{:else if conversion}
			<div class="flex flex-col px-3 pb-3">
				{#if rows[0].valid}{@render tile(rows[0], 0, 'From')}{:else}{@render badRow(rows[0])}{/if}
				<div
					class="relative z-10 mx-auto -my-2 grid size-7 place-items-center rounded-full bg-card text-foreground/70 shadow-sm ring-1 ring-border"
					aria-hidden="true"
				>
					<ArrowDownIcon class="size-3.5" />
				</div>
				<div class="flex flex-col gap-2">
					{#each rows.slice(1) as row, i (i)}
						{#if row.valid}{@render tile(
								row,
								i + 1,
								undefined,
								rows.length > 2
							)}{:else}{@render badRow(row)}{/if}
					{/each}
				</div>
			</div>
		{:else}
			<div class="flex flex-col gap-2 px-3 pb-3">
				{#each rows as row, i (i)}
					{#if row.valid}{@render tile(row, i + 1)}{:else}{@render badRow(row)}{/if}
				{/each}
			</div>
		{/if}
	{/if}
</WidgetCard>
