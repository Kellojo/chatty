<script lang="ts">
	import SunIcon from '@lucide/svelte/icons/sun';
	import CloudSunIcon from '@lucide/svelte/icons/cloud-sun';
	import CloudIcon from '@lucide/svelte/icons/cloud';
	import CloudyIcon from '@lucide/svelte/icons/cloudy';
	import CloudFogIcon from '@lucide/svelte/icons/cloud-fog';
	import CloudDrizzleIcon from '@lucide/svelte/icons/cloud-drizzle';
	import CloudRainIcon from '@lucide/svelte/icons/cloud-rain';
	import CloudSnowIcon from '@lucide/svelte/icons/cloud-snow';
	import CloudLightningIcon from '@lucide/svelte/icons/cloud-lightning';
	import CloudHailIcon from '@lucide/svelte/icons/cloud-hail';
	import DropletsIcon from '@lucide/svelte/icons/droplets';
	import WindIcon from '@lucide/svelte/icons/wind';
	import NavigationIcon from '@lucide/svelte/icons/navigation';
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

	// WMO weather interpretation codes -> label + icon
	function condition(codeVal: number | null | undefined): { label: string; icon: Component } {
		const c = codeVal ?? -1;
		if (c === 0) return { label: 'Clear sky', icon: SunIcon };
		if (c === 1) return { label: 'Mainly clear', icon: CloudSunIcon };
		if (c === 2) return { label: 'Partly cloudy', icon: CloudSunIcon };
		if (c === 3) return { label: 'Overcast', icon: CloudIcon };
		if (c === 45 || c === 48) return { label: 'Fog', icon: CloudFogIcon };
		if (c >= 51 && c <= 55) return { label: 'Drizzle', icon: CloudDrizzleIcon };
		if (c === 56 || c === 57) return { label: 'Freezing drizzle', icon: CloudDrizzleIcon };
		if (c >= 61 && c <= 65) return { label: 'Rain', icon: CloudRainIcon };
		if (c === 66 || c === 67) return { label: 'Freezing rain', icon: CloudRainIcon };
		if (c >= 71 && c <= 77) return { label: 'Snow', icon: CloudSnowIcon };
		if (c >= 80 && c <= 82) return { label: 'Rain showers', icon: CloudRainIcon };
		if (c === 85 || c === 86) return { label: 'Snow showers', icon: CloudSnowIcon };
		if (c === 95) return { label: 'Thunderstorm', icon: CloudLightningIcon };
		if (c === 96 || c === 99) return { label: 'Hailstorm', icon: CloudHailIcon };
		return { label: 'Unknown', icon: CloudyIcon };
	}

	function round(v: number | null | undefined): string {
		if (v === null || v === undefined || Number.isNaN(v)) return '—';
		return String(Math.round(v));
	}

	function round1(v: number | null | undefined): string {
		if (v === null || v === undefined || Number.isNaN(v)) return '—';
		return (Math.round(v * 10) / 10).toString();
	}

	function dayLabel(dateStr: string, index: number): string {
		if (index === 0) return 'Today';
		try {
			const d = new Date(`${dateStr}T12:00:00`);
			return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d);
		} catch {
			return dateStr;
		}
	}

	// Map temperature (°C) to a color. We interpolate in OKLCH between curated
	// keyframes so the ramp blue -> slate -> orange -> red never crosses green.
	// Keyframes chosen to be individually clean (no muddy in-betweens).
	const TEMP_STOPS: Array<{ t: number; l: number; c: number; h: number }> = [
		{ t: -20, l: 0.52, c: 0.17, h: 275 }, // bitter deep violet-blue
		{ t: -5, l: 0.56, c: 0.18, h: 262 }, // freezing indigo
		{ t: 4, l: 0.6, c: 0.15, h: 250 }, // cold blue
		{ t: 12, l: 0.62, c: 0.09, h: 243 }, // cool blue-grey
		{ t: 19, l: 0.64, c: 0.04, h: 240 }, // mild neutral cool (comfort zone)
		{ t: 22, l: 0.65, c: 0.03, h: 60 }, // pivot: hue flips at ~zero chroma (invisible)
		{ t: 26, l: 0.66, c: 0.14, h: 60 }, // warm amber
		{ t: 33, l: 0.62, c: 0.19, h: 42 }, // hot orange
		{ t: 42, l: 0.56, c: 0.22, h: 26 } // scorching red
	];

	// Hue interpolation that never passes through the green band (~90-170).
	// Cool hues (blues ~230-280) and warm hues (reds/oranges ~20-70) sit on opposite
	// sides of green; we always rotate through violet/magenta (300-360) to bridge them.
	function lerpHue(h0: number, h1: number, f: number): number {
		// Normalize to [0,360)
		h0 = ((h0 % 360) + 360) % 360;
		h1 = ((h1 % 360) + 360) % 360;
		const inGreen = (h: number) => h > 85 && h < 175;
		let d = h1 - h0;
		if (d > 180) d -= 360;
		if (d < -180) d += 360;
		// If the short path dips into the green band, go the other way around.
		const mid = (((h0 + d * 0.5) % 360) + 360) % 360;
		if (inGreen(mid)) {
			d = d > 0 ? d - 360 : d + 360;
		}
		return (((h0 + d * f) % 360) + 360) % 360;
	}

	// The ramp is tuned for dark surfaces; deepen it on light ones so values keep contrast.
	const lightness = $derived(mode.current === 'dark' ? 0 : -0.1);

	function tempColor(v: number | null | undefined): string {
		if (v === null || v === undefined || Number.isNaN(v)) return 'var(--foreground)';
		const t = Math.max(TEMP_STOPS[0].t, Math.min(TEMP_STOPS[TEMP_STOPS.length - 1].t, v));
		for (let i = 0; i < TEMP_STOPS.length - 1; i++) {
			const a = TEMP_STOPS[i];
			const b = TEMP_STOPS[i + 1];
			if (t >= a.t && t <= b.t) {
				const f = (t - a.t) / (b.t - a.t);
				const l = a.l + (b.l - a.l) * f + lightness;
				const c = a.c + (b.c - a.c) * f;
				const h = lerpHue(a.h, b.h, f);
				return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;
			}
		}
		const last = TEMP_STOPS[TEMP_STOPS.length - 1];
		return `oklch(${last.l + lightness} ${last.c} ${last.h})`;
	}

	const tempUnit = $derived(data?.units?.temp ?? '°C');
	const windUnit = $derived(data?.units?.wind ?? 'km/h');
	const precipUnit = $derived(data?.units?.precip ?? 'mm');
	const loc = $derived(data?.location);
	const cur = $derived(data?.current);
	const daily = $derived(data?.daily ?? []);
	const today = $derived(daily[0]);
	const place = $derived(loc?.name ?? null);
	const region = $derived(
		[loc?.admin1, loc?.country].filter((v) => v && v !== loc?.name).join(', ') || null
	);
</script>

{#snippet stat(icon: Component, label: string, value: string, extra?: Snippet)}
	{@const Icon = icon}
	<div class="flex min-w-0 flex-col gap-0.5 rounded-xl bg-muted/50 px-3 py-2">
		<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
			<Icon class="size-3.5 shrink-0" aria-hidden="true" />
			{label}
		</span>
		<span class="flex items-center gap-1 text-sm font-medium tabular-nums">
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
	skeletonClass="h-56"
	raw={code}
	title={place}
	subtitle={region}
	divided={false}
>
	{#if data}
		{@const cond = condition(cur?.code)}
		{@const CondIcon = cond.icon}
		<!-- Now -->
		<div class="flex items-center gap-4 px-4 {place ? 'pt-1' : 'pt-4'} pb-4">
			<CondIcon
				class="size-14 shrink-0"
				stroke-width={1.25}
				style="color: {tempColor(cur?.temp)}"
				aria-hidden="true"
			/>
			<div class="flex min-w-0 flex-col">
				<div class="flex items-start">
					<span
						class="text-5xl leading-none font-semibold tracking-tight tabular-nums"
						style="color: {tempColor(cur?.temp)}">{round(cur?.temp)}</span
					>
					<span class="mt-1 ml-0.5 text-lg leading-none text-muted-foreground">{tempUnit}</span>
				</div>
				<span class="mt-1.5 text-sm text-muted-foreground">
					{cond.label}{#if today}<span class="tabular-nums">
							&nbsp;· H {round(today.tmax)}° L {round(today.tmin)}°</span
						>{/if}
				</span>
			</div>
		</div>

		<!-- Current details -->
		<div class="grid grid-cols-2 gap-2 px-4 pb-4 sm:grid-cols-4">
			{@render stat(ThermometerIcon, 'Feels like', `${round(cur?.feels)}${tempUnit}`)}
			{@render stat(DropletsIcon, 'Humidity', `${round(cur?.humidity)}%`)}
			{@render stat(WindIcon, 'Wind', `${round(cur?.wind)} ${windUnit}`, windArrow)}
			{@render stat(UmbrellaIcon, 'Precipitation', `${round1(cur?.precip)} ${precipUnit}`)}
		</div>

		<!-- Daily forecast -->
		{#if daily.length > 0}
			<div class="[scrollbar-width:none] overflow-x-auto border-t border-border/60">
				<ul class="flex w-full gap-0.5 p-2" aria-label="Daily forecast">
					{#each daily as day, i (day.date)}
						{@const dc = condition(day.code)}
						{@const DayIcon = dc.icon}
						{@const isToday = i === 0}
						{@const rain = (day.precipProb ?? 0) > 0}
						<li
							class="flex min-w-11 flex-1 flex-col items-center gap-1.5 rounded-xl px-1 py-2 text-center {isToday
								? 'bg-muted/60'
								: ''}"
						>
							<span
								class="text-xs {isToday
									? 'font-semibold text-foreground'
									: 'font-medium text-muted-foreground'}">{dayLabel(day.date, i)}</span
							>
							<DayIcon class="size-5 text-muted-foreground" aria-label={dc.label} />
							<span class="flex flex-col items-center leading-tight tabular-nums">
								<span class="text-sm font-semibold" style="color: {tempColor(day.tmax)}"
									>{round(day.tmax)}°</span
								>
								<span class="text-xs text-muted-foreground">{round(day.tmin)}°</span>
							</span>
							<span
								class="flex h-3 items-center gap-0.5 text-[11px] leading-none text-sky-600 tabular-nums dark:text-sky-400 {rain
									? ''
									: 'invisible'}"
								aria-hidden={!rain}
							>
								<DropletsIcon class="size-2.5" aria-hidden="true" />{round(day.precipProb)}%
							</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	{/if}
</WidgetCard>

{#snippet windArrow()}
	{#if cur?.windDir !== null && cur?.windDir !== undefined}
		<NavigationIcon
			class="size-3 text-muted-foreground"
			style="transform: rotate({(cur.windDir + 180) % 360}deg)"
			aria-label="Wind from {Math.round(cur.windDir)}°"
		/>
	{/if}
{/snippet}
