<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import type * as L from 'leaflet';
	import './map-widget.css';
	import MapPinIcon from '@lucide/svelte/icons/map-pin';
	import StarIcon from '@lucide/svelte/icons/star';
	import NavigationIcon from '@lucide/svelte/icons/navigation';
	import WidgetCard from './widget-card.svelte';
	import { cn } from '$lib/utils.js';
	import { getPrivateChat } from '$lib/private-context.js';
	// Google's official attribution asset, unmodified (its terms forbid changing it).
	import googleMapsLogo from '$lib/assets/google-maps-logo.svg';

	type Marker = {
		name?: string;
		lat: number;
		lng: number;
		address?: string;
		phone?: string;
		website?: string;
		rating?: number;
		notes?: string;
		summary?: string;
		openNow?: boolean;
		photos?: Photo[];
		reviews?: Review[];
	};

	type Photo = { url: string; author?: string; authorUrl?: string };

	type Review = {
		author?: string;
		authorUrl?: string;
		rating?: number;
		when?: string;
		text: string;
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

	// With a Google Maps key, Google's terms want its places on a Google map:
	// the server proxies Google's tiles. Outside the app layout, fall back to OSM.
	const google = $derived(page.data?.mapTiles === 'google');

	// In a private chat the map's tiles and place photos (which reveal the area
	// to the tile server / Google) only load once the user asks for them.
	const isPrivateChat = getPrivateChat();
	let tilesAllowed = $state(false);
	const showMap = $derived(tilesAllowed || !isPrivateChat());

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
		return data.markers
			.filter(
				(m) =>
					Number.isFinite(m.lat) &&
					Number.isFinite(m.lng) &&
					Math.abs(m.lat) <= 90 &&
					Math.abs(m.lng) <= 180
			)
			.map(cleanMarker);
	}

	const text = (v: unknown): string | undefined =>
		typeof v === 'string' && v.trim() ? v.trim() : undefined;

	/** Only http(s) links: the model writes these, so `javascript:` must never reach an href. */
	function webUrl(v: unknown, httpsOnly = false): string | undefined {
		if (typeof v !== 'string') return undefined;
		try {
			const url = new URL(v);
			if (url.protocol === 'https:' || (!httpsOnly && url.protocol === 'http:')) return url.href;
		} catch {
			// not a URL
		}
		return undefined;
	}

	// Photos are served by our own server; a model-supplied external image URL
	// would reveal the viewer to a third party, so anything else is dropped.
	const PHOTO_URL = /^\/api\/maps\/photo\/[A-Za-z0-9_-]+$/;

	function cleanMarker(m: Marker): Marker {
		const photos = (Array.isArray(m.photos) ? m.photos : [])
			.filter(
				(p): p is Photo =>
					typeof p === 'object' && p !== null && typeof p.url === 'string' && PHOTO_URL.test(p.url)
			)
			.map((p) => ({ url: p.url, author: text(p.author), authorUrl: webUrl(p.authorUrl, true) }));
		const reviews = (Array.isArray(m.reviews) ? m.reviews : [])
			.filter((r): r is Review => typeof r === 'object' && r !== null && !!text(r.text))
			.map((r) => ({
				text: text(r.text) ?? '',
				author: text(r.author),
				authorUrl: webUrl(r.authorUrl, true),
				rating:
					typeof r.rating === 'number' &&
					Number.isFinite(r.rating) &&
					r.rating >= 0 &&
					r.rating <= 5
						? r.rating
						: undefined,
				when: text(r.when)
			}));
		return {
			...m,
			website: webUrl(m.website),
			summary: text(m.summary),
			openNow: typeof m.openNow === 'boolean' ? m.openNow : undefined,
			photos,
			reviews
		};
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

	/** An author name, linked to their profile when there is one. */
	function credit(author: string, url: string | undefined): string {
		const name = escapeHtml(author);
		return url
			? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${name}</a>`
			: name;
	}

	function buildPhoto(m: Marker): string {
		const photo = m.photos?.[0];
		if (!photo) return '';
		const alt = escapeHtml(m.name ? `Photo of ${m.name}` : 'Place photo');
		const caption = photo.author
			? `<figcaption>Photo: ${credit(photo.author, photo.authorUrl)}</figcaption>`
			: '';
		return `<figure class="map-widget-photo"><img src="${escapeHtml(photo.url)}" alt="${alt}" loading="lazy" width="240" height="135">${caption}</figure>`;
	}

	function buildReviews(m: Marker): string {
		const reviews = (m.reviews ?? []).slice(0, 2);
		if (reviews.length === 0) return '';
		const items = reviews.map((r) => {
			const by = [r.author && `— ${credit(r.author, r.authorUrl)}`, r.when && escapeHtml(r.when)]
				.filter(Boolean)
				.join(' · ');
			const meta = [r.rating !== undefined && `★ ${r.rating}`, by].filter(Boolean).join(' ');
			const metaHtml = meta ? `<p class="map-widget-review-meta">${meta}</p>` : '';
			return `<li><p class="map-widget-review-text">${escapeHtml(r.text)}</p>${metaHtml}</li>`;
		});
		return `<ul class="map-widget-reviews" aria-label="Reviews">${items.join('')}</ul>`;
	}

	function buildPopupContent(m: Marker): string {
		const lines: string[] = [];
		if (m.name) lines.push(`<strong>${escapeHtml(m.name)}</strong>`);
		if (m.rating !== undefined) lines.push(`★ ${m.rating}`);
		if (m.summary) lines.push(escapeHtml(m.summary));
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
		return (
			buildPhoto(m) +
			`<div>${lines.join('<br>')}</div>` +
			buildReviews(m) +
			`<div>${links.join(' · ')}</div>`
		);
	}

	/** Hide an image that fails to load instead of showing a broken icon. */
	function hideOnError(img: HTMLImageElement): void {
		if (img.complete && img.naturalWidth === 0) img.hidden = true;
		else img.addEventListener('error', () => (img.hidden = true), { once: true });
	}

	// Google requires its copyright line for the area shown, so refresh it as
	// the map moves (debounced; a newer view aborts the request for an older one).
	let attribution = '';
	let attributionTimer: ReturnType<typeof setTimeout> | undefined;
	let attributionRequest: AbortController | undefined;

	function setAttribution(m: L.Map, next: string): void {
		if (next === attribution) return;
		if (attribution) m.attributionControl.removeAttribution(attribution);
		attribution = next;
		m.attributionControl.addAttribution(next);
	}

	function scheduleAttribution(m: L.Map): void {
		clearTimeout(attributionTimer);
		attributionTimer = setTimeout(() => void refreshAttribution(m), 300);
	}

	async function refreshAttribution(m: L.Map): Promise<void> {
		attributionRequest?.abort();
		const request = new AbortController();
		attributionRequest = request;
		const b = m.getBounds();
		const clamp = (v: number, max: number) => String(Math.max(-max, Math.min(max, v)));
		const params = new URLSearchParams({
			zoom: String(Math.round(m.getZoom())),
			north: clamp(b.getNorth(), 90),
			south: clamp(b.getSouth(), 90),
			east: clamp(b.getEast(), 180),
			west: clamp(b.getWest(), 180)
		});
		let copyright = 'Google';
		try {
			const res = await fetch(`/api/maps/attribution?${params}`, { signal: request.signal });
			if (res.ok) {
				const body = (await res.json()) as { copyright?: unknown };
				copyright = text(body.copyright) ?? copyright;
			}
		} catch {
			// fall back to "Google"
		}
		if (request.signal.aborted || map !== m) return;
		setAttribution(m, escapeHtml(copyright));
	}

	async function initMap(): Promise<void> {
		if (!mapEl || map) return;
		// Leaflet touches `window` at module scope, so it must never be
		// statically imported — load it (and its CSS) only in the browser.
		const [leaf, css] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
		void css;
		leaflet = leaf;
		// Wheel zoom only once the map is engaged, so scrolling the chat past it keeps scrolling.
		// On phones a one-finger swipe should scroll the chat, not pan the map; pinch still zooms.
		map = leaf.map(mapEl, {
			attributionControl: true,
			scrollWheelZoom: false,
			dragging: !leaf.Browser.mobile
		});
		const m = map;
		m.on('click focus', () => m.scrollWheelZoom.enable());
		m.on('blur mouseout', () => m.scrollWheelZoom.disable());
		if (google) {
			leaf.tileLayer('/api/maps/tiles/{z}/{x}/{y}', { maxZoom: 22 }).addTo(map);
			// The outlined logo is the one for busy backgrounds like a map. Leaflet's 10px
			// control margins give the clear space Google asks for (10 / 5 at the bottom).
			const logo = new leaf.Control({ position: 'bottomleft' });
			logo.onAdd = () => {
				const img = leaf.DomUtil.create('img', 'map-widget-google-logo');
				img.src = googleMapsLogo;
				img.alt = 'Google Maps';
				img.draggable = false;
				return img;
			};
			logo.addTo(m);
			setAttribution(m, 'Google');
			m.on('moveend zoomend', () => scheduleAttribution(m));
		} else {
			leaf
				.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
					maxZoom: 19,
					attribution:
						'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
				})
				.addTo(map);
		}
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
			marker.on('popupopen', (e) => {
				e.popup.getElement()?.querySelectorAll('img').forEach(hideOnError);
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
		if (mapEl && showMap) initMap();
		if (initialized && map) renderMarkers();
	});

	onMount(() => () => {
		clearTimeout(attributionTimer);
		attributionRequest?.abort();
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
			{#if showMap}
				<div
					class={cn(
						'isolate h-64 w-full shrink-0 bg-muted',
						sideList ? 'md:h-auto md:min-h-80 md:flex-1' : 'md:h-72'
					)}
					class:map-widget-google={google}
					bind:this={mapEl}
				></div>
			{:else}
				<div
					class={cn(
						'flex h-64 w-full shrink-0 flex-col items-center justify-center gap-2 bg-muted px-4 text-center',
						sideList ? 'md:h-auto md:min-h-80 md:flex-1' : 'md:h-72'
					)}
				>
					<p class="text-xs text-muted-foreground">
						Private chat: the map loads from {google ? 'Google Maps' : 'OpenStreetMap'} only when you
						ask.
					</p>
					<button
						type="button"
						class="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
						onclick={() => (tilesAllowed = true)}
					>
						Show map
					</button>
				</div>
			{/if}
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
							{#if showMap && m.photos?.[0]}
								<img
									src={m.photos[0].url}
									alt=""
									loading="lazy"
									width="40"
									height="40"
									class="size-10 shrink-0 rounded-lg bg-muted object-cover"
									onerror={(e) => ((e.currentTarget as HTMLImageElement).hidden = true)}
								/>
							{/if}
							<button
								type="button"
								class="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring/50"
								onclick={() => focusMarker(i)}
							>
								<span class="truncate text-sm font-medium"
									>{m.name ?? `Place ${i + 1}`}<span class="sr-only">, show on map</span></span
								>
								{#if m.address || m.rating !== undefined || m.openNow !== undefined}
									<span class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
										{#if m.rating !== undefined}
											<span class="inline-flex shrink-0 items-center gap-0.5 tabular-nums">
												<StarIcon class="size-3 fill-amber-500 text-amber-500" aria-hidden="true" />
												{m.rating}
											</span>
										{/if}
										{#if m.openNow !== undefined}
											{#if m.rating !== undefined}<span aria-hidden="true">·</span>{/if}
											<span class={cn('shrink-0', m.openNow && 'text-success-foreground')}
												>{m.openNow ? 'Open now' : 'Closed'}</span
											>
										{/if}
										{#if m.address}
											{#if m.rating !== undefined || m.openNow !== undefined}<span
													aria-hidden="true">·</span
												>{/if}
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
