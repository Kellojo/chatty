<script lang="ts">
	import { onMount } from 'svelte';
	import type * as L from 'leaflet';
	import './map-widget.css';
	import MapPinIcon from '@lucide/svelte/icons/map-pin';
	import StarIcon from '@lucide/svelte/icons/star';
	import NavigationIcon from '@lucide/svelte/icons/navigation';
	import LinkIcon from '@lucide/svelte/icons/link';

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
			`<a href="https://www.google.com/maps/dir/?api=1&destination=${m.lat},${m.lng}" target="_blank" rel="noopener noreferrer">Directions</a>`
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
		map = leaf.map(mapEl, { attributionControl: true });
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
				iconSize: [26, 26],
				iconAnchor: [13, 24],
				popupAnchor: [0, -22],
				html: '<div class="map-widget-pin"></div>'
			});
			const marker = leaf.marker([m.lat, m.lng], { title: m.name, icon });
			marker.bindPopup(buildPopupContent(m), { maxWidth: 260 });
			marker.on('popupopen', () => {
				const button = listEl?.querySelectorAll('li button')[i];
				button?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
				button?.classList.add('map-widget-item-active');
				setTimeout(() => button?.classList.remove('map-widget-item-active'), 1500);
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

<div
	class="map-widget my-4 w-full overflow-hidden rounded-xl border border-border bg-card shadow-sm"
>
	{#if !data}
		<div class="flex items-center gap-3 p-4">
			<MapPinIcon class="size-5 animate-pulse text-muted-foreground" />
			<span class="text-sm text-muted-foreground">
				{isIncomplete ? 'Loading map…' : 'Could not render map'}
			</span>
		</div>
	{:else}
		{#if data.title}
			<div class="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
				<MapPinIcon class="size-4 text-muted-foreground" />
				<span class="text-sm font-medium text-foreground">{data.title}</span>
				<span class="ml-auto text-xs text-muted-foreground"
					>{markers.length} place{markers.length === 1 ? '' : 's'}</span
				>
			</div>
		{/if}
		<div class="flex flex-col md:flex-row">
			<div class="h-72 w-full shrink-0 md:h-auto md:min-h-80 md:flex-1" bind:this={mapEl}></div>
			<div
				class="max-h-60 overflow-y-auto border-t border-border/60 md:max-h-96 md:w-64 md:shrink-0 md:border-t-0 md:border-l"
				bind:this={listEl}
			>
				<ul class="divide-y divide-border/60">
					{#each markers as m, i (i)}
						<li class="flex items-start gap-2 px-3 py-2.5">
							<button
								type="button"
								class="flex min-w-0 flex-1 flex-col gap-0.5 text-left transition-colors hover:text-foreground focus:outline-none"
								onclick={() => focusMarker(i)}
							>
								<span class="truncate text-sm font-medium text-foreground"
									>{m.name ?? `Place ${i + 1}`}</span
								>
								{#if m.address}
									<span class="truncate text-xs text-muted-foreground">{m.address}</span>
								{/if}
							</button>
							<span class="flex shrink-0 items-center gap-2 pt-0.5 text-xs text-muted-foreground">
								{#if m.rating !== undefined}
									<span class="inline-flex items-center gap-0.5">
										<StarIcon class="size-3 text-amber-500" />{m.rating}
									</span>
								{/if}
								{#if m.website}
									<LinkIcon class="size-3" />
								{/if}
								<a
									href={`https://www.google.com/maps/dir/?api=1&destination=${m.lat},${m.lng}`}
									target="_blank"
									rel="noopener noreferrer"
									class="inline-flex items-center gap-0.5 text-info underline-offset-2 hover:underline"
								>
									<NavigationIcon class="size-3" />Directions
								</a>
							</span>
						</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}
</div>
