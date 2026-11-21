import { describe, expect, it, vi } from 'vitest';
import type { FetchImpl } from '../websearch/providers.js';
import {
	createTileSession,
	fetchCopyright,
	fetchPlacePhoto,
	fetchTile,
	GoogleMapsError,
	PLACES_API,
	searchGooglePlaces,
	TILES_API
} from './google.js';

type Reply = { status?: number; body: unknown; contentType?: string };

function mockFetch(reply: Reply | ((url: URL, init?: RequestInit) => Reply)) {
	return vi.fn(async (input: unknown, init?: RequestInit) => {
		const {
			status = 200,
			body,
			contentType = 'application/json'
		} = typeof reply === 'function' ? reply(new URL(String(input)), init) : reply;
		const payload =
			typeof body === 'string' || body instanceof Uint8Array
				? (body as BodyInit)
				: JSON.stringify(body);
		return new Response(payload, { status, headers: { 'content-type': contentType } });
	});
}

const asFetch = (f: ReturnType<typeof mockFetch>) => f as unknown as FetchImpl;

/** The parsed JSON body and headers of the nth request. */
function request(f: ReturnType<typeof mockFetch>, n = 0) {
	const [input, init] = f.mock.calls[n];
	return {
		url: String(input),
		headers: new Headers(init?.headers),
		body: init?.body ? JSON.parse(String(init.body)) : undefined,
		method: init?.method ?? 'GET'
	};
}

const photoUrl = (name: string) => `/photo/${encodeURIComponent(name)}`;

const LONG_REVIEW = 'Great noodles. '.repeat(40);

/** A Places API (New) place as Google returns it for the requested field mask. */
const PLACE = {
	id: 'ChIJ123',
	displayName: { text: 'Ramen Kuma', languageCode: 'en' },
	formattedAddress: 'Rua Augusta 1, 1100-048 Lisboa, Portugal',
	location: { latitude: 38.7101, longitude: -9.1366 },
	primaryTypeDisplayName: { text: 'Ramen restaurant', languageCode: 'en' },
	rating: 4.6,
	userRatingCount: 1820,
	priceLevel: 'PRICE_LEVEL_MODERATE',
	internationalPhoneNumber: '+351 21 123 4567',
	nationalPhoneNumber: '21 123 4567',
	websiteUri: 'https://ramenkuma.example/',
	googleMapsUri: 'https://maps.google.com/?cid=123',
	currentOpeningHours: { openNow: true },
	regularOpeningHours: {
		weekdayDescriptions: ['Monday: 12:00 – 22:00', 'Tuesday: Closed']
	},
	editorialSummary: { text: 'Cosy spot for tonkotsu ramen.', languageCode: 'en' },
	photos: [1, 2, 3, 4].map((i) => ({
		name: `places/ChIJ123/photos/ref${i}`,
		widthPx: 4000,
		heightPx: 3000,
		authorAttributions: [
			{
				displayName: `Photographer ${i}`,
				uri: `https://maps.google.com/maps/contrib/${i}`,
				photoUri: '//lh3.googleusercontent.com/a/x'
			}
		]
	})),
	reviews: [
		{
			name: 'places/ChIJ123/reviews/r1',
			relativePublishTimeDescription: '2 weeks ago',
			rating: 5,
			text: { text: LONG_REVIEW, languageCode: 'en' },
			originalText: { text: LONG_REVIEW, languageCode: 'en' },
			authorAttribution: { displayName: 'Ana', uri: 'https://www.google.com/maps/contrib/a' }
		},
		{ rating: 4, text: { text: 'Good broth.' }, authorAttribution: { displayName: 'Bo' } },
		{ rating: 3, originalText: { text: 'Bom.' } },
		{ rating: 2, text: { text: 'Too salty.' } }
	]
};

describe('searchGooglePlaces', () => {
	it('runs a Text Search with the location in the query and a capped bias circle', async () => {
		const fetchImpl = mockFetch({ body: { places: [] } });
		await searchGooglePlaces(
			'g-key',
			{
				query: 'ramen',
				location: 'lisbon portugal',
				latitude: 38.7,
				longitude: -9.1,
				radius: 200_000,
				limit: 50
			},
			{ photoUrl, language: 'pt-PT' },
			asFetch(fetchImpl)
		);
		const req = request(fetchImpl);
		expect(req.method).toBe('POST');
		expect(req.url).toBe(`${PLACES_API}/places:searchText`);
		expect(req.headers.get('x-goog-api-key')).toBe('g-key');
		const mask = req.headers.get('x-goog-fieldmask')!.split(',');
		expect(mask).toContain('places.displayName');
		expect(mask).toContain('places.reviews');
		expect(mask.every((f) => f.startsWith('places.'))).toBe(true);
		expect(req.body).toEqual({
			textQuery: 'ramen in lisbon portugal',
			pageSize: 20,
			languageCode: 'pt-PT',
			locationBias: {
				circle: { center: { latitude: 38.7, longitude: -9.1 }, radius: 50_000 }
			}
		});
	});

	it('searches for popular places when there is no query or coordinates', async () => {
		const fetchImpl = mockFetch({ body: {} });
		const places = await searchGooglePlaces(
			'k',
			{ location: 'austin tx', limit: 5 },
			{ photoUrl },
			asFetch(fetchImpl)
		);
		expect(places).toEqual([]);
		const req = request(fetchImpl);
		expect(req.url).toBe(`${PLACES_API}/places:searchText`);
		expect(req.body).toEqual({ textQuery: 'popular places in austin tx', pageSize: 5 });
	});

	it('runs a Nearby Search around the coordinates when there is no query', async () => {
		const fetchImpl = mockFetch({ body: { places: [] } });
		await searchGooglePlaces(
			'k',
			{ latitude: 1, longitude: 2, limit: 30 },
			{ photoUrl },
			asFetch(fetchImpl)
		);
		const req = request(fetchImpl);
		expect(req.url).toBe(`${PLACES_API}/places:searchNearby`);
		expect(req.body).toEqual({
			maxResultCount: 20,
			locationRestriction: { circle: { center: { latitude: 1, longitude: 2 }, radius: 1500 } }
		});
		expect(req.headers.get('x-goog-fieldmask')).toContain('places.photos');
	});

	it('caps the Nearby Search radius at 50 km', async () => {
		const fetchImpl = mockFetch({ body: { places: [] } });
		await searchGooglePlaces(
			'k',
			{ latitude: 1, longitude: 2, radius: 80_000, limit: 3 },
			{ photoUrl },
			asFetch(fetchImpl)
		);
		expect(request(fetchImpl).body.locationRestriction.circle.radius).toBe(50_000);
	});

	it('maps a place with rating, price, hours, photos and reviews', async () => {
		const fetchImpl = mockFetch({ body: { places: [PLACE] } });
		const [place] = await searchGooglePlaces(
			'k',
			{ query: 'ramen', location: 'lisbon', limit: 3 },
			{ photoUrl },
			asFetch(fetchImpl)
		);
		expect(place).toEqual({
			name: 'Ramen Kuma',
			address: 'Rua Augusta 1, 1100-048 Lisboa, Portugal',
			categories: ['Ramen restaurant'],
			rating: '4.6/5 (1820 reviews)',
			price: '$$',
			phone: '+351 21 123 4567',
			openingHours: 'Monday: 12:00 – 22:00; Tuesday: Closed',
			openNow: true,
			summary: 'Cosy spot for tonkotsu ramen.',
			coordinates: [38.7101, -9.1366],
			website: 'https://ramenkuma.example/',
			listing: 'https://maps.google.com/?cid=123',
			photos: [1, 2, 3].map((i) => ({
				url: photoUrl(`places/ChIJ123/photos/ref${i}`),
				author: `Photographer ${i}`,
				authorUrl: `https://maps.google.com/maps/contrib/${i}`
			})),
			reviews: [
				{
					author: 'Ana',
					authorUrl: 'https://www.google.com/maps/contrib/a',
					rating: 5,
					when: '2 weeks ago',
					text: expect.stringMatching(/^Great noodles\. .*…$/)
				},
				{ author: 'Bo', rating: 4, text: 'Good broth.' },
				{ rating: 3, text: 'Bom.' }
			]
		});
		expect(place.reviews![0].text.length).toBeLessThanOrEqual(300);
	});

	it('leaves out photos when photoUrl returns null, and fields Google left out', async () => {
		const fetchImpl = mockFetch({
			body: {
				places: [
					{ ...PLACE, priceLevel: undefined, userRatingCount: undefined, reviews: [] },
					{ displayName: { text: 'Bare' }, nationalPhoneNumber: '21 000' },
					{ formattedAddress: 'no name' }
				]
			}
		});
		const places = await searchGooglePlaces(
			'k',
			{ query: 'x', location: 'y', limit: 5 },
			{ photoUrl: () => null },
			asFetch(fetchImpl)
		);
		expect(places).toHaveLength(2);
		expect(places[0].photos).toBeUndefined();
		expect(places[0].reviews).toBeUndefined();
		expect(places[0].price).toBeUndefined();
		expect(places[0].rating).toBe('4.6/5');
		expect(places[1]).toEqual({ name: 'Bare', phone: '21 000' });
	});

	it("throws Google's error message, marking a turned-down key as rejected", async () => {
		const fetchImpl = mockFetch({
			status: 403,
			body: {
				error: {
					code: 403,
					message: 'Places API (New) has not been used in project 1 before or it is disabled.',
					status: 'PERMISSION_DENIED'
				}
			}
		});
		const error = await searchGooglePlaces(
			'k',
			{ query: 'x', location: 'y', limit: 1 },
			{ photoUrl },
			asFetch(fetchImpl)
		).catch((e) => e);
		expect(error).toBeInstanceOf(GoogleMapsError);
		expect(error.message).toBe(
			'Google Places returned HTTP 403: Places API (New) has not been used in project 1 before or it is disabled.'
		);
		expect(error.rejected).toBe(true);
	});

	it.each([400, 401, 403])('treats HTTP %i as rejected', async (status) => {
		const fetchImpl = mockFetch({ status, body: 'nope', contentType: 'text/plain' });
		const error = await searchGooglePlaces(
			'k',
			{ location: 'y', limit: 1 },
			{ photoUrl },
			asFetch(fetchImpl)
		).catch((e) => e);
		expect(error).toMatchObject({
			rejected: true,
			message: `Google Places returned HTTP ${status}`
		});
	});

	it("doesn't treat a server error as rejected", async () => {
		const fetchImpl = mockFetch({ status: 500, body: { error: { message: 'Internal error' } } });
		const error = await searchGooglePlaces(
			'k',
			{ location: 'y', limit: 1 },
			{ photoUrl },
			asFetch(fetchImpl)
		).catch((e) => e);
		expect(error).toBeInstanceOf(GoogleMapsError);
		expect(error).toMatchObject({
			rejected: false,
			message: 'Google Places returned HTTP 500: Internal error'
		});
	});

	it('says when Google is unreachable', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') });
		});
		await expect(
			searchGooglePlaces(
				'k',
				{ location: 'y', limit: 1 },
				{ photoUrl },
				fetchImpl as unknown as FetchImpl
			)
		).rejects.toThrow('Google Places is unreachable (getaddrinfo ENOTFOUND)');
	});

	it('says when the answer is not JSON', async () => {
		const fetchImpl = mockFetch({ body: '<html>', contentType: 'text/html' });
		await expect(
			searchGooglePlaces('k', { location: 'y', limit: 1 }, { photoUrl }, asFetch(fetchImpl))
		).rejects.toThrow(/other than JSON/);
	});

	it('passes the caller abort through', async () => {
		const fetchImpl = vi.fn(
			(_input: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
				})
		);
		const controller = new AbortController();
		const reason = new Error('turn stopped');
		const pending = searchGooglePlaces(
			'k',
			{ query: 'q', location: 'x', limit: 1, signal: controller.signal },
			{ photoUrl },
			fetchImpl as unknown as FetchImpl
		);
		controller.abort(reason);
		// The abort itself, not "Google Places is unreachable".
		await expect(pending).rejects.toBe(reason);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});

describe('fetchPlacePhoto', () => {
	it('fetches the media endpoint at the asked width', async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const fetchImpl = vi.fn(
			async () =>
				new Response(bytes, {
					headers: { 'content-type': 'image/jpeg; charset=binary', 'cache-control': 'max-age=60' }
				})
		);
		const image = await fetchPlacePhoto(
			'k',
			'places/ChIJ123/photos/ref-1_a',
			480,
			fetchImpl as unknown as FetchImpl
		);
		const [input, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(String(input)).toBe(`${PLACES_API}/places/ChIJ123/photos/ref-1_a/media?maxWidthPx=480`);
		expect(new Headers(init.headers).get('x-goog-api-key')).toBe('k');
		expect(image).toEqual({ body: bytes, type: 'image/jpeg', cacheControl: 'max-age=60' });
	});

	it.each([
		'places/abc',
		'places/abc/photos/',
		'places/../photos/x',
		'places/a/photos/b/media',
		'https://evil.example/places/a/photos/b',
		'places/a/photos/b?key=x'
	])('refuses %s without fetching', async (name) => {
		const fetchImpl = vi.fn();
		await expect(
			fetchPlacePhoto('k', name, 480, fetchImpl as unknown as FetchImpl)
		).rejects.toThrow(GoogleMapsError);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('rejects an answer that is not an image', async () => {
		const fetchImpl = mockFetch({ body: { error: 'x' } });
		await expect(
			fetchPlacePhoto('k', 'places/a/photos/b', 480, asFetch(fetchImpl))
		).rejects.toThrow('Google Places photos answered with application/json, not an image');
	});

	it('rejects an image over 5 MB', async () => {
		const fetchImpl = mockFetch({
			body: new Uint8Array(5 * 1024 * 1024 + 1),
			contentType: 'image/png'
		});
		await expect(
			fetchPlacePhoto('k', 'places/a/photos/b', 480, asFetch(fetchImpl))
		).rejects.toThrow(/over 5242880 bytes/);
	});
});

describe('map tiles', () => {
	it('creates a roadmap session and reads the expiry as epoch seconds', async () => {
		const fetchImpl = mockFetch({
			body: {
				session: 'sess-1',
				expiry: '1800000000',
				tileWidth: 256,
				tileHeight: 256,
				imageFormat: 'png'
			}
		});
		const session = await createTileSession('t-key', {}, asFetch(fetchImpl));
		expect(session).toEqual({ session: 'sess-1', expiresAt: 1_800_000_000_000 });
		const req = request(fetchImpl);
		expect(req.method).toBe('POST');
		expect(req.url).toBe(`${TILES_API}/v1/createSession?key=t-key`);
		expect(req.body).toEqual({ mapType: 'roadmap', language: 'en-US', region: 'US' });
	});

	it('fails when Google returns no session', async () => {
		const fetchImpl = mockFetch({ body: { expiry: '1800000000' } });
		await expect(createTileSession('k', {}, asFetch(fetchImpl))).rejects.toThrow(
			'Google Map Tiles returned no session'
		);
	});

	it('names Map Tiles in its errors', async () => {
		const fetchImpl = mockFetch({
			status: 403,
			body: { error: { message: 'Map Tiles API has not been used' } }
		});
		await expect(createTileSession('k', {}, asFetch(fetchImpl))).rejects.toMatchObject({
			message: 'Google Map Tiles returned HTTP 403: Map Tiles API has not been used',
			rejected: true
		});
	});

	it('fetches a tile with the session and key', async () => {
		const fetchImpl = mockFetch({ body: 'png', contentType: 'image/png' });
		const tile = await fetchTile('k', 'sess-1', 3, 4, 5, asFetch(fetchImpl));
		expect(String(fetchImpl.mock.calls[0][0])).toBe(
			`${TILES_API}/v1/2dtiles/3/4/5?session=sess-1&key=k`
		);
		expect(tile.type).toBe('image/png');
		expect(new TextDecoder().decode(tile.body)).toBe('png');
	});

	it('asks for the copyright line of a viewport', async () => {
		const fetchImpl = mockFetch({ body: { copyright: 'Map data ©2026 Google', maxZoomRects: [] } });
		const copyright = await fetchCopyright(
			'k',
			'sess-1',
			{ zoom: 12, north: 38.8, south: 38.6, east: -9, west: -9.3 },
			asFetch(fetchImpl)
		);
		expect(copyright).toBe('Map data ©2026 Google');
		const url = new URL(String(fetchImpl.mock.calls[0][0]));
		expect(url.origin + url.pathname).toBe(`${TILES_API}/tile/v1/viewport`);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			session: 'sess-1',
			key: 'k',
			zoom: '12',
			north: '38.8',
			south: '38.6',
			east: '-9',
			west: '-9.3'
		});
	});
});
