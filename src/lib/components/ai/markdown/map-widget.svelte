<script lang="ts">
	import { onMount } from 'svelte';
	import type * as L from 'leaflet';
	import './map-widget.css';
	import MapPinIcon from '@lucide/svelte/icons/map-pin';
	import StarIcon from '@lucide/svelte/icons/star';
	import NavigationIcon from '@lucide/svelte/icons/navigation';
	import WidgetCard from './widget-card.svelte';
	import { cn } from '$lib/utils.js';

	type Marker = {
		name?: string;
		lat: number;
		lng: number;
		address?: string;
		phone?: string;
		website?: string;
		rating?: number;
		notes?: string;
	};

	type Payload = {
		title?: string;
		center?: [number, number];
		zoom?: number;
		markers: Marker[];
	};

	type Props = {
		code: string;
		isIncomplete: boolean;
	};

	let { code, isIncomplete }: Props = $props();

	let mapEl: HTMLDivElement | undefined = $state();
	let listEl: HTMLDivElement | undefined = $state();
	let leaflet: typeof import('leaflet') | null = null;
	let map: L.Map | null = null;
	let layer: L.LayerGroup | null = null;
	let initialized = $state(false);

	function tileUrl(): string {
		return 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
	}

	const data = $derived.by((): Payload | null => {
		if (isIncomplete) return null;
		try {
			const parsed = JSON.parse(code) as Payload;
			if (typeof parsed !== 'object' || parsed === null) return null;
			if (!Array.isArray(parsed.markers) || parsed.markers.length === 0) return null;
			for (const m of parsed.markers) {
				if (
					typeof m !== 'object' ||
					m === null ||
					typeof m.lat !== 'number' ||
					typeof m.lng !== 'number' ||
					!Number.isFinite(m.lat) ||
					!Number.isFinite(m.lng)
				)
					return null;
			}
			return parsed;
		} catch {
			return null;
		}
	});

	const markers = $derived(validMarkers());
	// A side list only pays off with several places; a few sit under the map.
	const sideList = $derived(markers.length > 3);

	function validMarkers(): Marker[] {
		if (!data) return [];
		return data.markers.filter(
			(m) =>
				Number.isFinite(m.lat) &&
				Number.isFinite(m.lng) &&
				Math.abs(m.lat) <= 90 &&
				Math.abs(m.lng) <= 180
		);
	}

	function escapeHtml(s: string): string {
		return s
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');
	}

	function directionsUrl(m: Marker): string {
		return `https://www.google.com/maps/dir/?api=1&destination=${m.lat},${m.lng}`;
	}

	function buildPopupContent(m: Marker): string {
		const lines: string[] = [];
		if (m.name) lines.push(`<strong>${escapeHtml(m.name)}</strong>`);
		if (m.rating !== undefined) lines.push(`★ ${m.rating}`);
		if (m.address) lines.push(escapeHtml(m.address));
		if (m.notes) lines.push(escapeHtml(m.notes));
		const links: string[] = [];
		if (m.website) {
			links.push(
				`<a href="${escapeHtml(m.website)}" target="_blank" rel="noopener noreferrer">Website</a>`
			);
		}
		if (m.phone) {
			links.push(`<a href="tel:${escapeHtml(m.phone)}">Call</a>`);
		}
		links.push(
			`<a href="${directionsUrl(m)}" target="_blank" rel="noopener noreferrer">Directions</a>`
		);
		lines.push(links.join(' · '));
		return lines.join('<br>');
	}

	async function initMap(): Promise<void> {
		if (!mapEl || map) return;
		// Leaflet touches `window` at module scope, so it must never be
		// statically imported — load it (and its CSS) only in the browser.
		const [leaf, css] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
		void css;
		leaflet = leaf;
		// Wheel zoom only once the map is engaged, so scrolling the chat past it keeps scrolling.
		map = leaf.map(mapEl, { attributionControl: true, scrollWheelZoom: false });
		const m = map;
		m.on('click focus', () => m.scrollWheelZoom.enable());
		m.on('blur mouseout', () => m.scrollWheelZoom.disable());
		leaf
			.tileLayer(tileUrl(), {
				maxZoom: 19,
				attribution:
					'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
			})
			.addTo(map);
		layer = leaf.layerGroup().addTo(map);
		initialized = true;
	}

	function renderMarkers(): void {
		if (!map || !leaflet) return;
		const leaf = leaflet;
		const group = layer;
		if (!group) return;
		group.clearLayers();
		const all = validMarkers();
		if (all.length === 0) {
			if (data?.center && data.center.length === 2) map.setView(data.center, data.zoom ?? 13);
			return;
		}
		const bounds: L.LatLngTuple[] = all.map((m) => [m.lat, m.lng]);
		all.forEach((m, i) => {
			const icon = leaf.divIcon({
				className: 'map-widget-marker',
				iconSize: [32, 32],
				iconAnchor: [16, 30],
				popupAnchor: [0, -28],
				html: `<div class="map-widget-pin"><span>${i + 1}</span></div>`
			});
			const marker = leaf.marker([m.lat, m.lng], { title: m.name, icon });
			marker.bindPopup(buildPopupContent(m), { maxWidth: 260 });
			marker.on('popupopen', () => {
				const item = listEl?.querySelectorAll('li')[i];
				item?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
				item?.classList.add('map-widget-item-active');
				setTimeout(() => item?.classList.remove('map-widget-item-active'), 1500);
			});
			marker.addTo(group);
		});
		if (all.length === 1) {
			map.setView(bounds[0], data?.zoom ?? 15);
		} else {
			map.fitBounds(bounds, { padding: [36, 36], maxZoom: 17 });
		}
	}

	function focusMarker(i: number): void {
		if (!map || !layer) return;
		const m = validMarkers()[i];
		if (!m) return;
		map.setView([m.lat, m.lng], Math.max(map.getZoom(), 15));
		(layer.getLayers() as L.Marker[])[i]?.openPopup();
	}

	// The map container only exists in the DOM once the fence is complete, so
	// (re)initialize whenever it appears; the container may mount after onMount.
	$effect(() => {
		if (mapEl) initMap();
		if (initialized && map) renderMarkers();
	});

	onMount(() => () => {
		map?.remove();
		map = null;
		layer = null;
		leaflet = null;
	});
</script>

<WidgetCard
	icon={MapPinIcon}
	class="map-widget"
	status={data ? 'ready' : isIncomplete ? 'loading' : 'error'}
	loadingLabel="Loading map…"
	errorLabel="Could not render map"
	skeletonClass="h-64 md:h-80"
	raw={code}
	title={data?.title ?? 'Map'}
	meta={`${markers.length} place${markers.length === 1 ? '' : 's'}`}
>
	{#if data}
		<div class={cn('flex flex-col', sideList && 'md:flex-row')}>
			<div
				class={cn(
					'isolate h-64 w-full shrink-0 bg-muted',
					sideList ? 'md:h-auto md:min-h-80 md:flex-1' : 'md:h-72'
				)}
				bind:this={mapEl}
			></div>
			<div
				class={cn(
					'max-h-64 overflow-y-auto border-t border-border/60',
					sideList && 'md:max-h-96 md:w-72 md:shrink-0 md:border-t-0 md:border-l'
				)}
				bind:this={listEl}
			>
				<ol class={cn('grid gap-0.5 p-1.5', !sideList && 'sm:grid-cols-2')}>
					{#each markers as m, i (i)}
						<li
							class="group/place relative flex min-w-0 items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors hover:bg-muted/60 has-[button:focus-visible]:bg-muted/60"
						>
							<span
								class="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground tabular-nums"
								aria-hidden="true">{i + 1}</span
							>
							<button
								type="button"
								class="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring/50"
								onclick={() => focusMarker(i)}
							>
								<span class="truncate text-sm font-medium"
									>{m.name ?? `Place ${i + 1}`}<span class="sr-only">, show on map</span></span
								>
								{#if m.address || m.rating !== undefined}
									<span class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
										{#if m.rating !== undefined}
											<span class="inline-flex shrink-0 items-center gap-0.5 tabular-nums">
												<StarIcon class="size-3 fill-amber-500 text-amber-500" aria-hidden="true" />
												{m.rating}
											</span>
										{/if}
										{#if m.address}
											{#if m.rating !== undefined}<span aria-hidden="true">·</span>{/if}
											<span class="truncate">{m.address}</span>
										{/if}
									</span>
								{/if}
							</button>
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={directionsUrl(m)}
								target="_blank"
								rel="noopener noreferrer"
								class="relative z-10 -my-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
								title="Directions"
								aria-label="Directions to {m.name ?? `place ${i + 1}`}"
							>
								<NavigationIcon class="size-3.5" />
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						</li>
					{/each}
				</ol>
			</div>
		</div>
	{/if}
</WidgetCard>
