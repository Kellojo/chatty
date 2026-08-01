<script lang="ts">
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
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

	const tempUnit = $derived(data?.units?.temp ?? '°C');
	const windUnit = $derived(data?.units?.wind ?? 'km/h');
	const precipUnit = $derived(data?.units?.precip ?? 'mm');
	const loc = $derived(data?.location);
	const cur = $derived(data?.current);
	const daily = $derived(data?.daily ?? []);
	const weekMin = $derived(Math.min(...daily.map((d) => d.tmin ?? Infinity)));
	const weekMax = $derived(Math.max(...daily.map((d) => d.tmax ?? -Infinity)));
	const weekSpan = $derived(Math.max(1, weekMax - weekMin));

	function rangeLeft(d: Daily): number {
		const tmin = d.tmin ?? weekMin;
		return ((tmin - weekMin) / weekSpan) * 100;
	}
	function rangeWidth(d: Daily): number {
		const tmin = d.tmin ?? weekMin;
		const tmax = d.tmax ?? weekMax;
		return Math.max(4, ((tmax - tmin) / weekSpan) * 100);
	}

	function isNight(codeVal: number | null | undefined): boolean {
		// Heuristic only used for icon accent; keep simple
		return false;
	}
</script>

{#snippet stat(icon: Component, label: string, value: string)}
	{@const Icon = icon}
	<div class="flex items-center gap-2">
		<Icon class="size-4 shrink-0 text-muted-foreground" />
		<div class="flex flex-col">
			<span class="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</span>
			<span class="text-sm font-medium text-foreground">{value}</span>
		</div>
	</div>
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
		<!-- Current conditions -->
		<div class="flex items-center justify-between gap-4 p-4 pb-3">
			<div class="flex items-center gap-4">
				<CondIcon class="size-11 shrink-0 text-foreground" stroke-width={1.5} />
				<div class="flex flex-col">
					<div class="flex items-baseline gap-1">
						<span class="text-4xl font-semibold tracking-tight text-foreground"
							>{round(cur?.temp)}</span
						>
						<span class="text-xl text-muted-foreground">{tempUnit}</span>
					</div>
					<span class="text-sm text-muted-foreground">{cond.label}</span>
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

		<!-- Stats row -->
		<div class="grid grid-cols-2 gap-3 border-t border-border/60 px-4 py-3 sm:grid-cols-4">
			{@render stat(ThermometerIcon, 'Feels like', `${round(cur?.feels)}${tempUnit}`)}
			{@render stat(DropletsIcon, 'Humidity', `${round(cur?.humidity)}%`)}
			<div class="flex items-center gap-2">
				<WindIcon class="size-4 shrink-0 text-muted-foreground" />
				<div class="flex flex-col">
					<span class="text-[10px] tracking-wide text-muted-foreground uppercase">Wind</span>
					<span class="flex items-center gap-1 text-sm font-medium text-foreground">
						{round(cur?.wind)}
						{windUnit}
						{#if cur?.windDir !== null && cur?.windDir !== undefined}
							<NavigationIcon
								class="size-3 text-muted-foreground"
								style="transform: rotate({(cur.windDir + 180) % 360}deg)"
							/>
						{/if}
					</span>
				</div>
			</div>
			{@render stat(UmbrellaIcon, 'Precip', `${round1(cur?.precip)} ${precipUnit}`)}
		</div>

		<!-- 7-day forecast -->
		{#if daily.length > 0}
			<div class="border-t border-border/60 px-3 py-1.5">
				{#each daily as day, i (day.date)}
					{@const dc = condition(day.code)}
					{@const DayIcon = dc.icon}
					{@const isToday = i === 0}
					<div
						class="flex items-center gap-x-3 border-b border-border/40 px-2 py-2.5 text-sm tabular-nums last:border-b-0 {isToday
							? '-mx-1 rounded-lg border-b-0 bg-primary/5 px-3 ring-1 ring-primary/15 dark:bg-primary/10'
							: ''}"
					>
						<span
							class="w-15 shrink-0 {isToday
								? 'font-semibold text-foreground'
								: 'font-medium text-foreground/80'}">{dayLabel(day.date, i)}</span
						>
						<span class="flex w-6 shrink-0 justify-center">
							<DayIcon class="size-4 {isToday ? 'text-foreground' : 'text-muted-foreground'}" />
						</span>
						<span
							class="flex w-12 shrink-0 items-center justify-end gap-1 text-xs {day.precipProb !==
								null &&
							day.precipProb !== undefined &&
							day.precipProb > 0
								? 'text-sky-600 dark:text-sky-400'
								: 'text-transparent'}"
						>
							<DropletsIcon class="size-3" />{day.precipProb !== null &&
							day.precipProb !== undefined &&
							day.precipProb > 0
								? `${round(day.precipProb)}%`
								: '0%'}
						</span>
						<span class="w-9 shrink-0 text-right text-muted-foreground">{round(day.tmin)}°</span>
						<div class="relative h-1.5 min-w-6 flex-1 rounded-full bg-muted/70">
							<div
								class="absolute h-full rounded-full bg-gradient-to-r from-sky-400 to-amber-400"
								style="left: {rangeLeft(day)}%; width: {rangeWidth(day)}%"
							></div>
						</div>
						<span
							class="w-9 shrink-0 text-right {isToday
								? 'font-semibold text-foreground'
								: 'font-medium text-foreground'}">{round(day.tmax)}°</span
						>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>
