import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { getDb, closeDb } = await import('../db/index.js');
const { getSetting, setSetting } = await import('../db/repo/settings.js');
const { encryptSecret } = await import('../crypto.js');
const { config } = await import('../config.js');
const { TILES_API } = await import('./google.js');
const maps = await import('./service.js');
type FetchImpl = import('../websearch/providers.js').FetchImpl;

const KEY_SETTING = 'maps.google.apiKey';
const HOUR_S = 60 * 60;

type Reply = { status?: number; body: unknown; contentType?: string };
type Api = 'places' | 'session' | 'tile' | 'photo';

const apiOf = (url: string): Api =>
	url.includes('/media?')
		? 'photo'
		: url.includes('places.googleapis.com')
			? 'places'
			: url.includes('/createSession')
				? 'session'
				: 'tile';

/** Answers like Google, per API; a route can be a function for replies that change per call. */
function googleFetch(routes: Partial<Record<Api, Reply | ((n: number) => Reply)>> = {}) {
	const counts: Record<Api, number> = { places: 0, session: 0, tile: 0, photo: 0 };
	const defaults: Record<Api, Reply> = {
		places: { body: { places: [] } },
		session: { body: { session: 'sess-1', expiry: String(Date.now() / 1000 + 14 * 24 * HOUR_S) } },
		tile: { body: 'png', contentType: 'image/png' },
		photo: { body: 'jpg', contentType: 'image/jpeg' }
	};
	const fetchMock = vi.fn(async (input: unknown) => {
		const api = apiOf(String(input));
		const route = routes[api];
		const reply = typeof route === 'function' ? route(counts[api]++) : (route ?? defaults[api]);
		const { status = 200, body, contentType = 'application/json' } = reply;
		return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
			status,
			headers: { 'content-type': contentType }
		});
	});
	const calls = (api: Api) =>
		fetchMock.mock.calls.filter(([input]) => apiOf(String(input)) === api);
	return Object.assign(fetchMock, { calls }) as unknown as FetchImpl & {
		calls: typeof calls;
	};
}

const sessionReply = (session: string, expiresInS: number): Reply => ({
	body: { session, expiry: String(Math.floor(Date.now() / 1000) + expiresInS) }
});

beforeEach(() => {
	closeDb();
	config.GOOGLE_MAPS_API_KEY = undefined;
	maps.resetMapsState();
});

afterEach(() => {
	vi.restoreAllMocks();
	config.GOOGLE_MAPS_API_KEY = undefined;
});

describe('Google Maps key', () => {
	it('is unset by default, with OpenStreetMap tiles', () => {
		const db = getDb();
		expect(maps.getGoogleMapsKey(db)).toBeNull();
		expect(maps.mapTiles(db)).toBe('osm');
		expect(maps.getMapsInfo(db)).toEqual({ google: { source: null, hint: null }, tiles: 'osm' });
	});

	it('reads the encrypted setting', () => {
		const db = getDb();
		setSetting(db, KEY_SETTING, encryptSecret('app-key-1234'));
		expect(maps.getGoogleMapsKey(db)).toBe('app-key-1234');
		expect(maps.getMapsInfo(db)).toEqual({
			google: { source: 'app', hint: '1234' },
			tiles: 'google'
		});
	});

	it('lets the env var win over the saved key', () => {
		const db = getDb();
		setSetting(db, KEY_SETTING, encryptSecret('app-key-1234'));
		config.GOOGLE_MAPS_API_KEY = 'env-key-abcd';
		expect(maps.getGoogleMapsKey(db)).toBe('env-key-abcd');
		expect(maps.getMapsInfo(db)).toEqual({
			google: { source: 'env', hint: 'abcd' },
			tiles: 'google'
		});
	});

	it('ignores a saved key that no longer decrypts', () => {
		const db = getDb();
		setSetting(db, KEY_SETTING, 'not-an-encrypted-blob');
		expect(maps.getGoogleMapsKey(db)).toBeNull();
		expect(maps.mapTiles(db)).toBe('osm');
	});

	it('saves the key encrypted once Places and Map Tiles both accept it', async () => {
		const db = getDb();
		const fetchImpl = googleFetch();
		await maps.saveGoogleMapsKey(db, 'good-key-5678', fetchImpl);
		expect(fetchImpl.calls('places')).toHaveLength(1);
		expect(fetchImpl.calls('session')).toHaveLength(1);
		expect(getSetting<string>(db, KEY_SETTING)).not.toContain('good-key');
		expect(maps.getMapsInfo(db).google).toEqual({ source: 'app', hint: '5678' });

		maps.clearGoogleMapsKey(db);
		expect(getSetting(db, KEY_SETTING)).toBeUndefined();
		expect(maps.mapTiles(db)).toBe('osm');
	});

	it('names Places and hints at enabling it when Google rejects the key', async () => {
		const db = getDb();
		const fetchImpl = googleFetch({
			places: { status: 403, body: { error: { message: 'API key not valid' } } }
		});
		await expect(maps.saveGoogleMapsKey(db, 'bad-key', fetchImpl)).rejects.toThrow(
			'Google Places returned HTTP 403: API key not valid. ' +
				'Check the key, and that Places API (New) is enabled for its project.'
		);
		// Map Tiles isn't asked once Places failed.
		expect(fetchImpl.calls('session')).toHaveLength(0);
		expect(getSetting(db, KEY_SETTING)).toBeUndefined();
	});

	it('names Map Tiles when only it fails', async () => {
		const db = getDb();
		const fetchImpl = googleFetch({
			session: { status: 403, body: { error: { message: 'Map Tiles API is disabled' } } }
		});
		await expect(maps.saveGoogleMapsKey(db, 'half-key', fetchImpl)).rejects.toThrow(
			'Google Map Tiles returned HTTP 403: Map Tiles API is disabled. ' +
				'Check the key, and that Map Tiles API is enabled for its project.'
		);
		expect(getSetting(db, KEY_SETTING)).toBeUndefined();
	});

	it("doesn't hint at the key for a server error", async () => {
		const db = getDb();
		const fetchImpl = googleFetch({ places: { status: 503, body: {} } });
		const error = await maps.saveGoogleMapsKey(db, 'k', fetchImpl).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe('Google Places returned HTTP 503.');
		expect(getSetting(db, KEY_SETTING)).toBeUndefined();
	});
});

const PHOTO_PLACE = {
	displayName: { text: 'Café' },
	photos: [
		{ name: 'places/p1/photos/a', authorAttributions: [{ displayName: 'Ana' }] },
		{ name: 'places/p1/photos/b' }
	]
};

describe('place photos', () => {
	const query = { query: 'cafe', location: 'lisbon', limit: 3 };

	it('needs a key', () => {
		expect(() => maps.searchPlacesWithGoogle(getDb(), query, 'u1', googleFetch())).toThrow(
			/Google Maps API key/
		);
	});

	it("serves photo URLs only the searching user's photo lookups resolve", async () => {
		config.GOOGLE_MAPS_API_KEY = 'env-key';
		const fetchImpl = googleFetch({ places: { body: { places: [PHOTO_PLACE] } } });
		const [place] = await maps.searchPlacesWithGoogle(getDb(), query, 'u1', fetchImpl);
		const urls = place.photos!.map((p) => p.url);
		expect(urls).toHaveLength(2);
		expect(place.photos![0].author).toBe('Ana');
		for (const url of urls) expect(url).toMatch(/^\/api\/maps\/photo\/[\w-]{22}$/);
		const ids = urls.map((u) => u.slice(maps.PHOTO_PATH.length));
		expect(ids.map((id) => maps.photoName(id, 'u1'))).toEqual([
			'places/p1/photos/a',
			'places/p1/photos/b'
		]);
		expect(maps.photoName(ids[0], 'u2')).toBeNull();
		expect(maps.photoName('unknown-id', 'u1')).toBeNull();
	});

	it('gives another user who finds the same photo the same URL', async () => {
		config.GOOGLE_MAPS_API_KEY = 'env-key';
		const fetchImpl = googleFetch({ places: { body: { places: [PHOTO_PLACE] } } });
		const [mine] = await maps.searchPlacesWithGoogle(getDb(), query, 'u1', fetchImpl);
		const [theirs] = await maps.searchPlacesWithGoogle(getDb(), query, 'u2', fetchImpl);
		expect(theirs.photos![0].url).toBe(mine.photos![0].url);
		const id = mine.photos![0].url.slice(maps.PHOTO_PATH.length);
		expect(maps.photoName(id, 'u1')).toBe('places/p1/photos/a');
		expect(maps.photoName(id, 'u2')).toBe('places/p1/photos/a');
	});

	it('forgets photos after a week', async () => {
		config.GOOGLE_MAPS_API_KEY = 'env-key';
		const fetchImpl = googleFetch({ places: { body: { places: [PHOTO_PLACE] } } });
		const [place] = await maps.searchPlacesWithGoogle(getDb(), query, 'u1', fetchImpl);
		const id = place.photos![0].url.slice(maps.PHOTO_PATH.length);
		const later = Date.now() + 8 * 24 * HOUR_S * 1000;
		expect(maps.photoName(id, 'u1', later)).toBeNull();
		expect(maps.photoName(id, 'u1')).toBeNull();
	});

	it('leaves photos out without a user', async () => {
		config.GOOGLE_MAPS_API_KEY = 'env-key';
		const fetchImpl = googleFetch({ places: { body: { places: [PHOTO_PLACE] } } });
		const [place] = await maps.searchPlacesWithGoogle(getDb(), query, undefined, fetchImpl);
		expect(place).toEqual({ name: 'Café' });
	});

	it('loads a photo with the current key', async () => {
		const db = getDb();
		expect(await maps.loadPlacePhoto(db, 'places/p1/photos/a', googleFetch())).toBeNull();
		config.GOOGLE_MAPS_API_KEY = 'env-key';
		const fetchImpl = googleFetch();
		const image = await maps.loadPlacePhoto(db, 'places/p1/photos/a', fetchImpl);
		expect(image?.type).toBe('image/jpeg');
		expect(String(fetchImpl.calls('photo')[0][0])).toContain('maxWidthPx=480');
	});
});

describe('map tiles', () => {
	it('loads nothing without a key', async () => {
		const fetchImpl = googleFetch();
		expect(await maps.loadTile(getDb(), 1, 2, 3, fetchImpl)).toBeNull();
		expect(fetchImpl.calls('tile')).toHaveLength(0);
		expect(fetchImpl.calls('session')).toHaveLength(0);
	});

	it('creates one session for several tiles', async () => {
		config.GOOGLE_MAPS_API_KEY = 'env-key';
		const db = getDb();
		const fetchImpl = googleFetch();
		const tiles = await Promise.all([
			maps.loadTile(db, 1, 0, 0, fetchImpl),
			maps.loadTile(db, 1, 1, 0, fetchImpl)
		]);
		await maps.loadTile(db, 1, 1, 1, fetchImpl);
		expect(tiles.map((t) => t?.type)).toEqual(['image/png', 'image/png']);
		expect(fetchImpl.calls('session')).toHaveLength(1);
		expect(fetchImpl.calls('tile').map(([input]) => String(input))).toEqual([
			`${TILES_API}/v1/2dtiles/1/0/0?session=sess-1&key=env-key`,
			`${TILES_API}/v1/2dtiles/1/1/0?session=sess-1&key=env-key`,
			`${TILES_API}/v1/2dtiles/1/1/1?session=sess-1&key=env-key`
		]);
	});

	it('creates a new session when the key changes', async () => {
		const db = getDb();
		const fetchImpl = googleFetch({
			session: (n) => sessionReply(`sess-${n + 1}`, 14 * 24 * HOUR_S)
		});
		config.GOOGLE_MAPS_API_KEY = 'key-a';
		await maps.loadTile(db, 1, 0, 0, fetchImpl);
		config.GOOGLE_MAPS_API_KEY = 'key-b';
		await maps.loadTile(db, 1, 0, 0, fetchImpl);
		expect(fetchImpl.calls('session')).toHaveLength(2);
		expect(String(fetchImpl.calls('tile')[1][0])).toContain('session=sess-2&key=key-b');
	});

	it('creates a new session after the key is saved again', async () => {
		const db = getDb();
		const fetchImpl = googleFetch({
			session: (n) => sessionReply(`sess-${n + 1}`, 14 * 24 * HOUR_S)
		});
		setSetting(db, KEY_SETTING, encryptSecret('same-key'));
		await maps.loadTile(db, 1, 0, 0, fetchImpl);
		// Verifying the key asks for a session too, but that one isn't kept.
		await maps.saveGoogleMapsKey(db, 'same-key', fetchImpl);
		await maps.loadTile(db, 1, 0, 0, fetchImpl);
		expect(fetchImpl.calls('session')).toHaveLength(3);
		expect(String(fetchImpl.calls('tile')[1][0])).toContain('session=sess-3');
	});

	it('renews a session that expires within the hour', async () => {
		config.GOOGLE_MAPS_API_KEY = 'env-key';
		const db = getDb();
		const fetchImpl = googleFetch({
			session: (n) => sessionReply(`sess-${n + 1}`, n === 0 ? HOUR_S / 2 : 14 * 24 * HOUR_S)
		});
		await maps.loadTile(db, 1, 0, 0, fetchImpl);
		await maps.loadTile(db, 1, 0, 0, fetchImpl);
		await maps.loadTile(db, 1, 0, 0, fetchImpl);
		expect(fetchImpl.calls('session')).toHaveLength(2);
		expect(fetchImpl.calls('tile').map(([input]) => String(input).includes('sess-2'))).toEqual([
			false,
			true,
			true
		]);
	});

	it("doesn't keep a failed session", async () => {
		config.GOOGLE_MAPS_API_KEY = 'env-key';
		const db = getDb();
		const fetchImpl = googleFetch({
			session: (n) =>
				n === 0 ? { status: 500, body: {} } : sessionReply('sess-ok', 14 * 24 * HOUR_S)
		});
		await expect(maps.loadTile(db, 1, 0, 0, fetchImpl)).rejects.toThrow(/HTTP 500/);
		await maps.loadTile(db, 1, 0, 0, fetchImpl);
		expect(fetchImpl.calls('session')).toHaveLength(2);
		expect(String(fetchImpl.calls('tile')[0][0])).toContain('session=sess-ok');
	});

	it('shares the session with the copyright line', async () => {
		config.GOOGLE_MAPS_API_KEY = 'env-key';
		const db = getDb();
		const fetchImpl = googleFetch({ tile: { body: { copyright: 'Map data ©2026 Google' } } });
		const view = { zoom: 3, north: 1, south: 0, east: 1, west: 0 };
		expect(await maps.loadCopyright(db, view, fetchImpl)).toBe('Map data ©2026 Google');
		expect(await maps.loadCopyright(db, view, fetchImpl)).toBe('Map data ©2026 Google');
		expect(fetchImpl.calls('session')).toHaveLength(1);
	});

	it('forgets the session on resetMapsState', async () => {
		config.GOOGLE_MAPS_API_KEY = 'env-key';
		const db = getDb();
		const fetchImpl = googleFetch();
		await maps.loadTile(db, 1, 0, 0, fetchImpl);
		maps.resetMapsState();
		await maps.loadTile(db, 1, 0, 0, fetchImpl);
		expect(fetchImpl.calls('session')).toHaveLength(2);
	});
});
