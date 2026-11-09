<script lang="ts">
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import CloudSunIcon from '@lucide/svelte/icons/cloud-sun';
	import CloudMoonIcon from '@lucide/svelte/icons/cloud-moon';
	import CloudIcon from '@lucide/svelte/icons/cloud';
	import CloudyIcon from '@lucide/svelte/icons/cloudy';
	import CloudFogIcon from '@lucide/svelte/icons/cloud-fog';
	import CloudDrizzleIcon from '@lucide/svelte/icons/cloud-drizzle';
	import CloudRainIcon from '@lucide/svelte/icons/cloud-rain';
	import CloudSnowIcon from '@lucide/svelte/icons/cloud-snow';
	import CloudLightningIcon from '@lucide/svelte/icons/cloud-lightning';
	import CloudHailIcon from '@lucide/svelte/icons/cloud-hail';
	import DropletsIcon from '@lucide/svelte/icons/droplets';
	import DropletIcon from '@lucide/svelte/icons/droplet';
	import WindIcon from '@lucide/svelte/icons/wind';
	import NavigationIcon from '@lucide/svelte/icons/navigation-2';
	import UmbrellaIcon from '@lucide/svelte/icons/umbrella';
	import ThermometerIcon from '@lucide/svelte/icons/thermometer';
	import MapPinIcon from '@lucide/svelte/icons/map-pin';
	import type { Component, Snippet } from 'svelte';
	import WidgetCard from './widget-card.svelte';
	import { mode } from 'mode-watcher';

	type Daily = {
		date: string;
		code: number | null;
		tmin: number | null;
		tmax: number | null;
		precipSum: number | null;
		precipProb: number | null;
		windMax: number | null;
	};

	type Payload = {
		location?: {
			name?: string;
			country?: string | null;
			admin1?: string | null;
			timezone?: string | null;
		};
		current?: {
			temp?: number | null;
			feels?: number | null;
			humidity?: number | null;
			precip?: number | null;
			wind?: number | null;
			windDir?: number | null;
			code?: number | null;
			/** Absent in older payloads; treated as daytime. */
			isDay?: boolean | null;
		};
		units?: { temp?: string; wind?: string; precip?: string };
		daily?: Daily[];
	};

	type Props = {
		code: string;
		isIncomplete: boolean;
	};

	let { code, isIncomplete }: Props = $props();

	const data = $derived.by((): Payload | null => {
		if (isIncomplete) return null;
		try {
			const parsed = JSON.parse(code) as Payload;
			if (typeof parsed !== 'object' || parsed === null) return null;
			return parsed;
		} catch {
			return null;
		}
	});

	/** Broad sky family a WMO code belongs to; drives the hero backdrop and icon tint. */
	type Sky = 'clear' | 'partly' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm';

	type Condition = { label: string; icon: Component; sky: Sky };

	// WMO weather interpretation codes -> label, icon and sky family
	function condition(codeVal: number | null | undefined, night = false): Condition {
		const c = codeVal ?? -1;
		if (c === 0)
			return {
				label: 'Clear',
				icon: night ? MoonIcon : SunIcon,
				sky: 'clear'
			};
		if (c === 1)
			return { label: 'Mainly clear', icon: night ? CloudMoonIcon : CloudSunIcon, sky: 'partly' };
		if (c === 2)
			return { label: 'Partly cloudy', icon: night ? CloudMoonIcon : CloudSunIcon, sky: 'partly' };
		if (c === 3) return { label: 'Overcast', icon: CloudIcon, sky: 'cloudy' };
		if (c === 45 || c === 48) return { label: 'Fog', icon: CloudFogIcon, sky: 'fog' };
		if (c >= 51 && c <= 55) return { label: 'Drizzle', icon: CloudDrizzleIcon, sky: 'rain' };
		if (c === 56 || c === 57)
			return { label: 'Freezing drizzle', icon: CloudDrizzleIcon, sky: 'rain' };
		if (c >= 61 && c <= 65) return { label: 'Rain', icon: CloudRainIcon, sky: 'rain' };
		if (c === 66 || c === 67) return { label: 'Freezing rain', icon: CloudRainIcon, sky: 'rain' };
		if (c >= 71 && c <= 77) return { label: 'Snow', icon: CloudSnowIcon, sky: 'snow' };
		if (c >= 80 && c <= 82) return { label: 'Rain showers', icon: CloudRainIcon, sky: 'rain' };
		if (c === 85 || c === 86) return { label: 'Snow showers', icon: CloudSnowIcon, sky: 'snow' };
		if (c === 95) return { label: 'Thunderstorm', icon: CloudLightningIcon, sky: 'storm' };
		if (c === 96 || c === 99) return { label: 'Hailstorm', icon: CloudHailIcon, sky: 'storm' };
		return { label: 'Unknown', icon: CloudyIcon, sky: 'cloudy' };
	}

	// Hero backdrops. Every stop stays dark enough (L ≤ ~0.55) for white text to
	// read at small sizes, in both app themes — the hero is its own surface.
	const SKY_BG: Record<Sky, { day: string; night: string }> = {
		clear: {
			day: 'radial-gradient(45% 60% at 86% 42%, oklch(0.97 0.05 85 / 0.38), transparent 70%), linear-gradient(160deg, oklch(0.54 0.15 248), oklch(0.43 0.16 262))',
			night:
				'radial-gradient(80% 70% at 85% 10%, oklch(0.45 0.08 270 / 0.6), transparent 60%), linear-gradient(160deg, oklch(0.3 0.08 270), oklch(0.2 0.06 275))'
		},
		partly: {
			day: 'radial-gradient(45% 60% at 86% 42%, oklch(0.97 0.04 85 / 0.28), transparent 70%), linear-gradient(160deg, oklch(0.52 0.12 243), oklch(0.42 0.1 257))',
			night:
				'radial-gradient(80% 70% at 85% 10%, oklch(0.45 0.05 260 / 0.55), transparent 60%), linear-gradient(160deg, oklch(0.32 0.06 260), oklch(0.22 0.04 265))'
		},
		cloudy: {
			day: 'linear-gradient(160deg, oklch(0.51 0.04 250), oklch(0.39 0.035 255))',
			night: 'linear-gradient(160deg, oklch(0.33 0.03 255), oklch(0.23 0.025 260))'
		},
		fog: {
			day: 'linear-gradient(170deg, oklch(0.52 0.02 240), oklch(0.41 0.02 245))',
			night: 'linear-gradient(170deg, oklch(0.34 0.015 250), oklch(0.24 0.015 255))'
		},
		rain: {
			day: 'radial-gradient(90% 70% at 15% 0%, oklch(0.6 0.06 235 / 0.5), transparent 60%), linear-gradient(165deg, oklch(0.46 0.07 240), oklch(0.32 0.06 250))',
			night: 'linear-gradient(165deg, oklch(0.3 0.05 245), oklch(0.2 0.04 255))'
		},
		snow: {
			day: 'radial-gradient(100% 80% at 20% 0%, oklch(0.75 0.05 220 / 0.35), transparent 60%), linear-gradient(165deg, oklch(0.51 0.07 232), oklch(0.4 0.07 246))',
			night: 'linear-gradient(165deg, oklch(0.35 0.05 240), oklch(0.24 0.04 250))'
		},
		storm: {
			day: 'radial-gradient(90% 70% at 85% 0%, oklch(0.55 0.14 295 / 0.55), transparent 60%), linear-gradient(165deg, oklch(0.38 0.09 285), oklch(0.24 0.06 280))',
			night: 'linear-gradient(165deg, oklch(0.28 0.08 285), oklch(0.18 0.05 280))'
		}
	};

	// Scorching clear days get a warm sun-bleached sky instead of the cool blue.
	const HOT_CLEAR_DAY =
		'radial-gradient(50% 65% at 86% 42%, oklch(0.93 0.11 85 / 0.32), transparent 70%), linear-gradient(160deg, oklch(0.5 0.14 50), oklch(0.4 0.13 30))';

	// Small-icon tints for the forecast rows, readable on the card surface in both themes.
	const SKY_TINT: Record<Sky, string> = {
		clear: 'text-amber-500 dark:text-amber-400',
		partly: 'text-amber-500 dark:text-amber-300',
		cloudy: 'text-slate-500 dark:text-slate-400',
		fog: 'text-slate-500 dark:text-slate-400',
		rain: 'text-sky-600 dark:text-sky-400',
		snow: 'text-cyan-600 dark:text-cyan-300',
		storm: 'text-violet-600 dark:text-violet-400'
	};

	/** Whole number with a typographic minus (U+2212) rather than a hyphen. */
	function round(v: number | null | undefined): string {
		if (v === null || v === undefined || Number.isNaN(v)) return '—';
		const n = Math.round(v);
		return n < 0 ? `−${-n}` : String(n);
	}

	function round1(v: number | null | undefined): string {
		if (v === null || v === undefined || Number.isNaN(v)) return '—';
		const n = Math.round(v * 10) / 10;
		return n < 0 ? `−${-n}` : String(n);
	}

	const num = (v: number | null | undefined): v is number =>
		v !== null && v !== undefined && !Number.isNaN(v);

	function dayLabel(dateStr: string, index: number): string {
		if (index === 0) return 'Today';
		try {
			const d = new Date(`${dateStr}T12:00:00`);
			return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d);
		} catch {
			return dateStr;
		}
	}

	const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
	function compass(deg: number): string {
		return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
	}

	// Map temperature (°C) to a color, interpolated in OKLCH between curated
	// keyframes: violet-blue -> blue -> cyan -> teal -> yellow -> amber -> orange -> red.
	// Chroma stays moderate so neighbouring bars read as one calm family.
	const TEMP_STOPS: Array<{ t: number; l: number; c: number; h: number }> = [
		{ t: -15, l: 0.58, c: 0.15, h: 290 }, // bitter
		{ t: -8, l: 0.62, c: 0.14, h: 268 }, // frigid
		{ t: -3, l: 0.68, c: 0.12, h: 245 }, // freezing
		{ t: 2, l: 0.74, c: 0.1, h: 222 }, // icy
		{ t: 8, l: 0.76, c: 0.1, h: 205 }, // cold
		{ t: 13, l: 0.76, c: 0.11, h: 200 }, // cool
		{ t: 19, l: 0.8, c: 0.13, h: 150 }, // mild
		{ t: 23, l: 0.84, c: 0.15, h: 75 }, // warm
		{ t: 28, l: 0.76, c: 0.16, h: 65 }, // hot
		{ t: 34, l: 0.68, c: 0.18, h: 42 }, // very hot
		{ t: 42, l: 0.6, c: 0.19, h: 25 } // scorching
	];

	// Light surfaces need a deeper ramp so the bars keep contrast against the track.
	// Warm hues go olive when darkened, so ease the shift off above ~15°C.
	const lightMode = $derived(mode.current !== 'dark');
	function lightnessShift(celsius: number): number {
		if (!lightMode) return 0;
		const warm = Math.max(0, Math.min(1, (celsius - 15) / 8));
		return -0.07 * (1 - warm);
	}

	function tempColor(v: number | null | undefined): string {
		if (!num(v)) return 'var(--muted-foreground)';
		// The ramp is in °C; convert when the payload is Fahrenheit.
		const celsius = tempUnit === '°F' ? ((v - 32) * 5) / 9 : v;
		const first = TEMP_STOPS[0];
		const last = TEMP_STOPS[TEMP_STOPS.length - 1];
		const t = Math.max(first.t, Math.min(last.t, celsius));
		let i = 0;
		while (i < TEMP_STOPS.length - 2 && t > TEMP_STOPS[i + 1].t) i++;
		const a = TEMP_STOPS[i];
		const b = TEMP_STOPS[i + 1];
		const f = (t - a.t) / (b.t - a.t);
		const l = a.l + (b.l - a.l) * f + lightnessShift(t);
		const c = a.c + (b.c - a.c) * f;
		const h = a.h + (b.h - a.h) * f;
		return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;
	}

	const tempUnit = $derived(data?.units?.temp ?? '°C');
	const windUnit = $derived(data?.units?.wind ?? 'km/h');
	const precipUnit = $derived(data?.units?.precip ?? 'mm');
	const loc = $derived(data?.location);
	const cur = $derived(data?.current);
	const night = $derived(cur?.isDay === false);
	const daily = $derived(data?.daily ?? []);
	const hot = $derived.by(() => {
		const t = cur?.temp;
		if (!num(t)) return false;
		return (tempUnit === '°F' ? ((t - 32) * 5) / 9 : t) >= 32;
	});
	// Today's daily min/max can be stale against the live reading (a forecast high
	// of 22° while it's 29° now). Widen them to include it so the hero, the row
	// labels and today's bar all agree with the big number.
	const days = $derived(
		daily.map((d, i) => {
			const t = cur?.temp;
			if (i !== 0 || !num(t)) return d;
			return {
				...d,
				tmin: num(d.tmin) ? Math.min(d.tmin, t) : d.tmin,
				tmax: num(d.tmax) ? Math.max(d.tmax, t) : d.tmax
			};
		})
	);
	const today = $derived(days[0]);
	const place = $derived(loc?.name ?? null);
	const region = $derived(
		[loc?.admin1, loc?.country].filter((v) => v && v !== loc?.name).join(', ') || null
	);

	// Shared scale for the forecast range bars: the whole week on one axis.
	const range = $derived.by(() => {
		const values = days.flatMap((d) => [d.tmin, d.tmax]).filter(num);
		if (num(cur?.temp)) values.push(cur.temp);
		if (values.length === 0) return null;
		const lo = Math.min(...values);
		const hi = Math.max(...values);
		return { lo, span: Math.max(hi - lo, 1) };
	});

	function pos(v: number): number {
		if (!range) return 0;
		return ((v - range.lo) / range.span) * 100;
	}
</script>

{#snippet stat(icon: Component, label: string, value: string, extra?: Snippet)}
	{@const Icon = icon}
	<div
		class="flex min-w-0 flex-col gap-1 rounded-xl bg-white/10 px-3 py-2.5 ring-1 ring-white/20 backdrop-blur-md ring-inset"
	>
		<span
			class="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-white/90 uppercase"
		>
			<Icon class="size-3.5 shrink-0" aria-hidden="true" />
			<span class="truncate">{label}</span>
		</span>
		<span class="flex items-center gap-1.5 text-base font-semibold text-white tabular-nums">
			{value}
			{@render extra?.()}
		</span>
	</div>
{/snippet}

<WidgetCard
	icon={MapPinIcon}
	status={data ? 'ready' : isIncomplete ? 'loading' : 'error'}
	loadingLabel="Loading weather…"
	errorLabel="Could not render weather"
	skeletonClass="h-[38rem] bg-linear-to-b from-sky-500/15 to-transparent @xl:h-[28rem]"
	raw={code}
	divided={false}
	class="@container"
>
	{#if data}
		{@const cond = condition(cur?.code, night)}
		{@const CondIcon = cond.icon}
		{@const bg =
			cond.sky === 'clear' && !night && hot
				? HOT_CLEAR_DAY
				: SKY_BG[cond.sky][night ? 'night' : 'day']}
		<!-- Hero: the current conditions on a sky that matches them -->
		<div class="relative isolate overflow-hidden text-white" style="background: {bg}">
			<div class="flex min-w-0 flex-col px-5 pt-4">
				{#if place}
					<h3 class="flex min-w-0 items-center gap-1.5 text-base font-semibold" title={place}>
						<MapPinIcon class="size-3.5 shrink-0 opacity-80" aria-hidden="true" />
						<span class="truncate">{place}</span>
					</h3>
				{/if}
				{#if region}
					<p class="truncate pl-5 text-xs text-white/80" title={region}>{region}</p>
				{/if}
			</div>

			<div class="flex items-center justify-between gap-4 px-5 pt-2 pb-4">
				<div class="flex min-w-0 flex-col">
					<div class="flex items-start [text-shadow:0_2px_12px_rgb(0_0_0/0.18)]">
						<span
							class="text-7xl leading-none font-light tabular-nums {num(cur?.temp) &&
							cur.temp < -0.5
								? 'tracking-tight'
								: 'tracking-tighter'}">{round(cur?.temp)}</span
						>
						<span class="mt-1.5 ml-0.5 text-2xl leading-none font-light text-white/80"
							>{tempUnit}</span
						>
					</div>
					{#if cond.label !== 'Unknown'}
						<span class="mt-2 text-base font-medium">{cond.label}</span>
					{/if}
					{#if today}
						<span class="text-sm text-white/90 tabular-nums">
							<span aria-hidden="true">H</span><span class="sr-only">High</span>
							{round(today.tmax)}° <span aria-hidden="true">·</span>
							<span aria-hidden="true">L</span><span class="sr-only">Low</span>
							{round(today.tmin)}°
						</span>
					{/if}
				</div>
				<CondIcon
					class="size-20 shrink-0 drop-shadow-[0_6px_18px_rgb(0_0_0/0.25)] @md:size-24"
					stroke-width={1.1}
					aria-hidden="true"
				/>
			</div>

			<!-- Current details -->
			<div class="grid grid-cols-2 gap-2 px-5 pb-5 @xl:grid-cols-4">
				{@render stat(ThermometerIcon, 'Feels like', `${round(cur?.feels)}${tempUnit}`)}
				{@render stat(DropletsIcon, 'Humidity', `${round(cur?.humidity)}%`)}
				{@render stat(WindIcon, 'Wind', `${round(cur?.wind)} ${windUnit}`, windArrow)}
				{@render stat(UmbrellaIcon, 'Precipitation', `${round1(cur?.precip)} ${precipUnit}`)}
			</div>
		</div>

		<!-- Daily forecast: one row per day, bars on a shared temperature axis -->
		{#if days.length > 0}
			<ul class="flex flex-col px-2 py-2" aria-label="Daily forecast">
				{#each days as day, i (day.date)}
					{@const dc = condition(day.code)}
					{@const DayIcon = dc.icon}
					{@const isToday = i === 0}
					{@const rain = (day.precipProb ?? 0) >= 10}
					{@const hasRange = num(day.tmin) && num(day.tmax)}
					{@const nowTemp = isToday && num(cur?.temp) ? cur.temp : null}
					<li
						class="grid grid-cols-[2.75rem_2.5rem_2.25rem_1fr_2.25rem] items-center gap-x-2 rounded-xl px-2.5 py-2 @md:grid-cols-[4rem_5rem_2.5rem_1fr_2.5rem] @md:gap-x-3 @md:px-3 {isToday
							? 'bg-muted/60 dark:bg-white/[0.06]'
							: ''}"
					>
						<span
							class="truncate text-sm {isToday
								? 'font-semibold text-foreground'
								: 'font-medium text-foreground/85'}">{dayLabel(day.date, i)}</span
						>
						<!-- Icon, with the rain chance stacked under it on narrow cards and beside it on wide ones -->
						<span class="flex flex-col items-center gap-0.5 @md:flex-row @md:gap-3">
							<DayIcon
								class="size-5 shrink-0 {SKY_TINT[dc.sky]}"
								role="img"
								aria-label={dc.label}
							/>
							<span
								class="flex items-center gap-0.5 text-[11px] leading-none font-medium text-sky-700 tabular-nums @md:text-xs dark:text-sky-400 {rain
									? ''
									: 'invisible'}"
								aria-hidden={!rain}
							>
								<DropletIcon class="size-3 shrink-0" aria-hidden="true" /><span class="sr-only"
									>Chance of rain</span
								>{round(day.precipProb)}%
							</span>
						</span>
						<span class="text-right text-sm text-muted-foreground tabular-nums"
							><span class="sr-only">Low </span>{round(day.tmin)}°</span
						>
						<span class="relative h-1.5 rounded-full bg-foreground/10" aria-hidden="true">
							{#if hasRange && range}
								<span
									class="absolute inset-y-0 rounded-full"
									style="left: {pos(day.tmin!)}%; right: {100 -
										pos(day.tmax!)}%; background: linear-gradient(90deg, {tempColor(
										day.tmin
									)}, {tempColor(day.tmax)})"
								></span>
								{#if nowTemp !== null}
									<span
										class="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-[0_0_0_3px_rgb(0_0_0/0.15)] ring-2 ring-white dark:shadow-none dark:ring-muted"
										style="left: clamp(5px, {pos(nowTemp)}%, calc(100% - 5px))"
									></span>
								{/if}
							{/if}
						</span>
						<span class="text-sm font-semibold tabular-nums"
							><span class="sr-only">High </span>{round(day.tmax)}°{#if nowTemp !== null}<span
									class="sr-only">, now {round(nowTemp)}°</span
								>{/if}</span
						>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</WidgetCard>

{#snippet windArrow()}
	{#if num(cur?.windDir)}
		<span class="flex items-center gap-1 text-xs font-medium text-white/80">
			<NavigationIcon
				class="size-3"
				style="transform: rotate({(cur.windDir + 180) % 360}deg)"
				aria-hidden="true"
			/>
			<span aria-hidden="true">{compass(cur.windDir)}</span>
			<span class="sr-only">from {compass(cur.windDir)}</span>
		</span>
	{/if}
{/snippet}
