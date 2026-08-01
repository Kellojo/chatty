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
	import type { Component } from 'svelte';

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

	function tempColor(v: number | null | undefined): string {
		if (v === null || v === undefined || Number.isNaN(v)) return 'var(--foreground)';
		const t = Math.max(TEMP_STOPS[0].t, Math.min(TEMP_STOPS[TEMP_STOPS.length - 1].t, v));
		for (let i = 0; i < TEMP_STOPS.length - 1; i++) {
			const a = TEMP_STOPS[i];
			const b = TEMP_STOPS[i + 1];
			if (t >= a.t && t <= b.t) {
				const f = (t - a.t) / (b.t - a.t);
				const l = a.l + (b.l - a.l) * f;
				const c = a.c + (b.c - a.c) * f;
				const h = lerpHue(a.h, b.h, f);
				return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;
			}
		}
		const last = TEMP_STOPS[TEMP_STOPS.length - 1];
		return `oklch(${last.l} ${last.c} ${last.h})`;
	}

	const tempUnit = $derived(data?.units?.temp ?? '°C');
	const windUnit = $derived(data?.units?.wind ?? 'km/h');
	const precipUnit = $derived(data?.units?.precip ?? 'mm');
	const loc = $derived(data?.location);
	const cur = $derived(data?.current);
	const daily = $derived(data?.daily ?? []);
</script>

{#snippet stat(icon: Component, label: string, value: string)}
	{@const Icon = icon}
	<span
		class="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2.5 py-1 text-xs font-medium text-foreground"
	>
		<Icon class="size-3.5 text-muted-foreground" />
		<span class="text-muted-foreground">{label}</span>
		{value}
	</span>
{/snippet}

<div class="my-4 w-full overflow-hidden rounded-xl border border-border bg-card shadow-sm">
	{#if !data}
		<div class="flex items-center gap-3 p-4">
			<CloudyIcon class="size-5 animate-pulse text-muted-foreground" />
			<span class="text-sm text-muted-foreground">Loading weather…</span>
		</div>
	{:else}
		{@const cond = condition(cur?.code)}
		{@const CondIcon = cond.icon}
		<!-- Hero -->
		<div class="flex items-start justify-between gap-3 p-4 pb-3">
			<div class="flex items-center gap-3">
				<CondIcon
					class="size-12 shrink-0"
					stroke-width={1.5}
					style="color: {tempColor(cur?.temp)}"
				/>
				<div class="flex flex-col">
					<div class="flex items-start gap-1">
						<span
							class="text-5xl leading-none font-semibold tracking-tight"
							style="color: {tempColor(cur?.temp)}">{round(cur?.temp)}</span
						>
						<span class="mt-0.5 text-xl leading-none text-muted-foreground">{tempUnit}</span>
					</div>
					<span class="mt-1 text-sm text-muted-foreground">{cond.label}</span>
				</div>
			</div>
			{#if loc?.name}
				<div class="flex flex-col items-end text-right">
					<span class="text-sm font-medium text-foreground">{loc.name}</span>
					{#if loc.country}
						<span class="text-xs text-muted-foreground"
							>{[loc.admin1, loc.country].filter(Boolean).join(', ')}</span
						>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Stat chips -->
		<div class="flex flex-wrap gap-1.5 px-4 pb-3">
			{@render stat(ThermometerIcon, 'Feels', `${round(cur?.feels)}${tempUnit}`)}
			{@render stat(DropletsIcon, 'Humidity', `${round(cur?.humidity)}%`)}
			<span
				class="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2.5 py-1 text-xs font-medium text-foreground"
			>
				<WindIcon class="size-3.5 text-muted-foreground" />
				{round(cur?.wind)}{windUnit}
				{#if cur?.windDir !== null && cur?.windDir !== undefined}
					<NavigationIcon
						class="size-3 text-muted-foreground"
						style="transform: rotate({(cur.windDir + 180) % 360}deg)"
					/>
				{/if}
			</span>
			{@render stat(UmbrellaIcon, 'Precip', `${round1(cur?.precip)}${precipUnit}`)}
		</div>

		<!-- 7-day strip -->
		{#if daily.length > 0}
			<div class="overflow-x-auto border-t border-border/60">
				<div class="flex w-full px-2 py-2">
					{#each daily as day, i (day.date)}
						{@const dc = condition(day.code)}
						{@const DayIcon = dc.icon}
						{@const isToday = i === 0}
						<div
							class="flex min-w-22 flex-1 flex-col items-center gap-1 rounded-lg px-1 py-2 text-center {isToday
								? 'bg-primary/5 ring-1 ring-primary/15 dark:bg-primary/10'
								: ''}"
						>
							<span
								class="text-xs {isToday
									? 'font-semibold text-foreground'
									: 'font-medium text-muted-foreground'}">{dayLabel(day.date, i)}</span
							>
							<DayIcon class="size-5 {isToday ? 'text-foreground' : 'text-muted-foreground'}" />
							<span class="text-sm font-semibold tabular-nums" style="color: {tempColor(day.tmax)}"
								>{round(day.tmax)}°</span
							>
							<span class="text-xs tabular-nums" style="color: {tempColor(day.tmin)}"
								>{round(day.tmin)}°</span
							>
							<span
								class="flex items-center gap-0.5 text-[10px] leading-none {day.precipProb !==
									null &&
								day.precipProb !== undefined &&
								day.precipProb > 0
									? 'text-sky-600 dark:text-sky-400'
									: 'text-transparent'}"
							>
								<DropletsIcon class="size-2.5" />{day.precipProb !== null &&
								day.precipProb !== undefined &&
								day.precipProb > 0
									? `${round(day.precipProb)}%`
									: '0%'}
							</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>
