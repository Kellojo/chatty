/**
 * Google Maps Platform: Places API (New) for place search with photos and reviews, and
 * the Map Tiles API for the map widget's tiles. Every call takes the API key and a
 * `fetch`, so the service decides where the key comes from and tests can stub requests.
 */
import {
	cancellable,
	httpUrl,
	networkMessage,
	readJson,
	requestSignal,
	type FetchImpl,
	type Place,
	type PlacePhoto,
	type PlaceQuery,
	type PlaceReview
} from '../websearch/providers.js';

export const PLACES_API = 'https://places.googleapis.com/v1';
export const TILES_API = 'https://tile.googleapis.com';

/** Google's own limit for results per search. */
const MAX_RESULTS = 20;
/** Searching nearby needs a radius; about a neighbourhood. */
const DEFAULT_NEARBY_RADIUS_M = 1500;
/** Google's limit for a location bias or restriction circle. */
const MAX_RADIUS_M = 50_000;
const MAX_PHOTOS = 3;
const MAX_REVIEWS = 3;
const MAX_REVIEW_CHARS = 300;
/** Photo and tile images; the media endpoint scales photos down to the asked width. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Only the fields the tool passes on: Google bills a search by the most expensive field
 * asked for, and reviews put it in the Enterprise + Atmosphere tier.
 */
const FIELDS = [
	'id',
	'displayName',
	'formattedAddress',
	'location',
	'primaryTypeDisplayName',
	'rating',
	'userRatingCount',
	'priceLevel',
	'internationalPhoneNumber',
	'nationalPhoneNumber',
	'websiteUri',
	'googleMapsUri',
	'currentOpeningHours.openNow',
	'regularOpeningHours.weekdayDescriptions',
	'editorialSummary',
	'photos',
	'reviews'
];
const FIELD_MASK = FIELDS.map((f) => `places.${f}`).join(',');

export class GoogleMapsError extends Error {
	constructor(
		message: string,
		/** Google turned the key down, or the API isn't enabled for it. */
		readonly rejected = false
	) {
		super(message);
		this.name = 'GoogleMapsError';
	}
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined =>
	typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Google's error body: `{ error: { code, message, status } }`. */
async function errorFor(res: Response, api: string): Promise<GoogleMapsError> {
	let message = '';
	try {
		message = str(obj(obj(await readJson(res)).error).message) ?? '';
	} catch {
		// Not JSON; the status says enough.
	}
	const rejected = res.status === 400 || res.status === 401 || res.status === 403;
	const detail = message ? `: ${message}` : '';
	return new GoogleMapsError(`${api} returned HTTP ${res.status}${detail}`, rejected);
}

async function send(
	url: string,
	init: RequestInit,
	api: string,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl
): Promise<Response> {
	return cancellable(signal, async () => {
		let res: Response;
		try {
			res = await fetchImpl(url, { ...init, signal: requestSignal(signal) });
		} catch (e) {
			throw new GoogleMapsError(`${api} is unreachable (${networkMessage(e)})`);
		}
		if (!res.ok) throw await errorFor(res, api);
		return res;
	});
}

async function postJson(
	url: string,
	apiKey: string,
	body: unknown,
	headers: Record<string, string>,
	api: string,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl
): Promise<Json> {
	const res = await send(
		url,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey, ...headers },
			body: JSON.stringify(body)
		},
		api,
		signal,
		fetchImpl
	);
	try {
		return obj(await readJson(res));
	} catch {
		throw new GoogleMapsError(`${api} answered with something other than JSON`);
	}
}

// ── Places ───────────────────────────────────────────────────────────────────

const PRICE_LEVELS: Record<string, string> = {
	PRICE_LEVEL_FREE: 'free',
	PRICE_LEVEL_INEXPENSIVE: '$',
	PRICE_LEVEL_MODERATE: '$$',
	PRICE_LEVEL_EXPENSIVE: '$$$',
	PRICE_LEVEL_VERY_EXPENSIVE: '$$$$'
};

function cut(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function toPhoto(p: Json, photoUrl: PhotoUrl): PlacePhoto | null {
	const name = str(p.name);
	const url = name && photoUrl(name);
	if (!url) return null;
	const author = obj((Array.isArray(p.authorAttributions) ? p.authorAttributions : [])[0]);
	return compact({
		url,
		author: str(author.displayName),
		authorUrl: httpUrl(author.uri)
	});
}

function toReview(r: Json): PlaceReview | null {
	const text = str(obj(r.text).text) ?? str(obj(r.originalText).text);
	if (!text) return null;
	const author = obj(r.authorAttribution);
	return compact({
		author: str(author.displayName),
		authorUrl: httpUrl(author.uri),
		rating: num(r.rating),
		when: str(r.relativePublishTimeDescription),
		text: cut(text, MAX_REVIEW_CHARS)
	});
}

function list<T>(v: unknown, map: (item: Json) => T | null, max: number): T[] | undefined {
	const items = (Array.isArray(v) ? v : [])
		.map((item) => map(obj(item)))
		.filter((item): item is T => item !== null)
		.slice(0, max);
	return items.length ? items : undefined;
}

function toPlace(p: Json, photoUrl: PhotoUrl): Place | null {
	const name = str(obj(p.displayName).text);
	const location = obj(p.location);
	const lat = num(location.latitude);
	const lng = num(location.longitude);
	if (!name) return null;
	const rating = num(p.rating);
	const reviews = num(p.userRatingCount);
	const type = str(obj(p.primaryTypeDisplayName).text);
	const hours = obj(p.regularOpeningHours).weekdayDescriptions;
	const openNow = obj(p.currentOpeningHours).openNow;
	return compact<Place>({
		name,
		address: str(p.formattedAddress),
		categories: type ? [type] : undefined,
		rating:
			rating !== undefined
				? `${rating}/5` + (reviews !== undefined ? ` (${reviews} reviews)` : '')
				: undefined,
		price: PRICE_LEVELS[str(p.priceLevel) ?? ''],
		phone: str(p.internationalPhoneNumber) ?? str(p.nationalPhoneNumber),
		openingHours: Array.isArray(hours)
			? hours.filter((h): h is string => typeof h === 'string').join('; ') || undefined
			: undefined,
		openNow: typeof openNow === 'boolean' ? openNow : undefined,
		summary: str(obj(p.editorialSummary).text),
		coordinates: lat !== undefined && lng !== undefined ? [lat, lng] : undefined,
		website: httpUrl(p.websiteUri),
		listing: httpUrl(p.googleMapsUri),
		photos: list(p.photos, (ph) => toPhoto(ph, photoUrl), MAX_PHOTOS),
		reviews: list(p.reviews, toReview, MAX_REVIEWS)
	});
}

function compact<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function circle(latitude: number, longitude: number, radius: number) {
	return { circle: { center: { latitude, longitude }, radius: Math.min(radius, MAX_RADIUS_M) } };
}

/** The URL the model and the map widget load a photo from, given Google's photo name; null leaves it out. */
type PhotoUrl = (name: string) => string | null;

export interface GooglePlaceOptions {
	photoUrl: PhotoUrl;
	/** BCP-47 language for names, addresses and reviews; Google's default when left out. */
	language?: string;
}

/**
 * Text Search ("ramen in lisbon portugal", biased towards the coordinates when given),
 * or Nearby Search around the coordinates when there's no query.
 */
export async function searchGooglePlaces(
	apiKey: string,
	q: PlaceQuery,
	opts: GooglePlaceOptions,
	fetchImpl: FetchImpl = fetch
): Promise<Place[]> {
	const limit = Math.min(q.limit, MAX_RESULTS);
	const hasCoords = q.latitude !== undefined && q.longitude !== undefined;
	const language = opts.language ? { languageCode: opts.language } : {};
	let body: Json;
	let endpoint: string;
	if (q.query || !hasCoords) {
		const where = q.location ? ` in ${q.location}` : '';
		endpoint = `${PLACES_API}/places:searchText`;
		body = {
			textQuery: `${q.query ?? 'popular places'}${where}`,
			pageSize: limit,
			...language,
			...(hasCoords && {
				locationBias: circle(q.latitude!, q.longitude!, q.radius ?? DEFAULT_NEARBY_RADIUS_M)
			})
		};
	} else {
		endpoint = `${PLACES_API}/places:searchNearby`;
		body = {
			maxResultCount: limit,
			...language,
			locationRestriction: circle(q.latitude!, q.longitude!, q.radius ?? DEFAULT_NEARBY_RADIUS_M)
		};
	}
	const data = await postJson(
		endpoint,
		apiKey,
		body,
		{ 'x-goog-fieldmask': FIELD_MASK },
		'Google Places',
		q.signal,
		fetchImpl
	);
	const places = Array.isArray(data.places) ? data.places : [];
	return places
		.map((p) => toPlace(obj(p), opts.photoUrl))
		.filter((p): p is Place => p !== null)
		.slice(0, limit);
}

/** A cheap search (place ids only, the free tier) that fails when the key can't use Places. */
export async function verifyPlacesKey(apiKey: string, fetchImpl: FetchImpl = fetch): Promise<void> {
	await postJson(
		`${PLACES_API}/places:searchText`,
		apiKey,
		{ textQuery: 'cafe', pageSize: 1 },
		{ 'x-goog-fieldmask': 'places.id' },
		'Google Places',
		undefined,
		fetchImpl
	);
}

export interface Image {
	body: Uint8Array<ArrayBuffer>;
	type: string;
	/** Google's cache-control, passed on so browsers keep images as long as allowed. */
	cacheControl: string | null;
}

async function readImage(res: Response, api: string): Promise<Image> {
	const type = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
	if (!type.startsWith('image/')) {
		await res.body?.cancel().catch(() => {});
		throw new GoogleMapsError(`${api} answered with ${type || 'no content type'}, not an image`);
	}
	const reader = res.body?.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	if (reader) {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_IMAGE_BYTES) {
				await reader.cancel().catch(() => {});
				throw new GoogleMapsError(`${api} sent an image over ${MAX_IMAGE_BYTES} bytes`);
			}
			chunks.push(value);
		}
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		body.set(c, offset);
		offset += c.byteLength;
	}
	return { body, type, cacheControl: res.headers.get('cache-control') };
}

/** A place photo, `name` as Places returned it ("places/…/photos/…"), scaled to `maxWidth`. */
export async function fetchPlacePhoto(
	apiKey: string,
	name: string,
	maxWidth: number,
	fetchImpl: FetchImpl = fetch
): Promise<Image> {
	if (!/^places\/[\w-]+\/photos\/[\w-]+$/.test(name)) {
		throw new GoogleMapsError('not a Google place photo');
	}
	const params = new URLSearchParams({ maxWidthPx: String(maxWidth) });
	const res = await send(
		`${PLACES_API}/${name}/media?${params}`,
		{ headers: { 'x-goog-api-key': apiKey } },
		'Google Places photos',
		undefined,
		fetchImpl
	);
	return readImage(res, 'Google Places photos');
}

// ── Map tiles ────────────────────────────────────────────────────────────────

export interface TileSession {
	session: string;
	/** Epoch milliseconds. */
	expiresAt: number;
}

/** A roadmap session; every tile request names it. Sessions last about two weeks. */
export async function createTileSession(
	apiKey: string,
	{ language = 'en-US', region = 'US' }: { language?: string; region?: string } = {},
	fetchImpl: FetchImpl = fetch
): Promise<TileSession> {
	const params = new URLSearchParams({ key: apiKey });
	const data = await postJson(
		`${TILES_API}/v1/createSession?${params}`,
		apiKey,
		{ mapType: 'roadmap', language, region },
		{},
		'Google Map Tiles',
		undefined,
		fetchImpl
	);
	const session = str(data.session);
	const expiry = Number(data.expiry);
	if (!session || !Number.isFinite(expiry)) {
		throw new GoogleMapsError('Google Map Tiles returned no session');
	}
	return { session, expiresAt: expiry * 1000 };
}

export async function fetchTile(
	apiKey: string,
	session: string,
	z: number,
	x: number,
	y: number,
	fetchImpl: FetchImpl = fetch
): Promise<Image> {
	const params = new URLSearchParams({ session, key: apiKey });
	const res = await send(
		`${TILES_API}/v1/2dtiles/${z}/${x}/${y}?${params}`,
		{},
		'Google Map Tiles',
		undefined,
		fetchImpl
	);
	return readImage(res, 'Google Map Tiles');
}

export interface Viewport {
	zoom: number;
	north: number;
	south: number;
	east: number;
	west: number;
}

/** The copyright line Google requires under the map for this view, e.g. "Map data ©2026 Google". */
export async function fetchCopyright(
	apiKey: string,
	session: string,
	view: Viewport,
	fetchImpl: FetchImpl = fetch
): Promise<string> {
	const params = new URLSearchParams({
		session,
		key: apiKey,
		zoom: String(view.zoom),
		north: String(view.north),
		south: String(view.south),
		east: String(view.east),
		west: String(view.west)
	});
	const res = await send(
		`${TILES_API}/tile/v1/viewport?${params}`,
		{},
		'Google Map Tiles',
		undefined,
		fetchImpl
	);
	try {
		return str(obj(await readJson(res)).copyright) ?? '';
	} catch {
		throw new GoogleMapsError('Google Map Tiles answered with something other than JSON');
	}
}
