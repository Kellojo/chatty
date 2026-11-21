import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import type { Db } from '../db/index.js';
import { deleteSetting, getSetting, setSetting } from '../db/repo/settings.js';
import { createLogger } from '../logger.js';
import type { FetchImpl, Place, PlaceQuery } from '../websearch/providers.js';
import {
	createTileSession,
	fetchCopyright,
	fetchPlacePhoto,
	fetchTile,
	GoogleMapsError,
	searchGooglePlaces,
	verifyPlacesKey,
	type Image,
	type TileSession,
	type Viewport
} from './google.js';

const log = createLogger('maps');

const KEY_SETTING = 'maps.google.apiKey';

/** Which tiles the map widget shows. Google's terms want Google places on a Google map. */
export type MapTiles = 'google' | 'osm';

export interface MapsInfo {
	google: { source: 'env' | 'app' | null; /** Last four characters. */ hint: string | null };
	tiles: MapTiles;
}

// ── Key ──────────────────────────────────────────────────────────────────────

function storedKey(db: Db): string | null {
	const blob = getSetting<string>(db, KEY_SETTING);
	if (!blob) return null;
	try {
		return decryptSecret(blob);
	} catch {
		log.warn('Stored Google Maps key could not be decrypted (APP_SECRET changed?)');
		return null;
	}
}

/** The env var wins, so Docker setups can pin the key; otherwise the one saved in the app. */
export function getGoogleMapsKey(db: Db): string | null {
	return config.GOOGLE_MAPS_API_KEY ?? storedKey(db);
}

export function mapTiles(db: Db): MapTiles {
	return getGoogleMapsKey(db) ? 'google' : 'osm';
}

export function getMapsInfo(db: Db): MapsInfo {
	const key = getGoogleMapsKey(db);
	return {
		google: {
			source: config.GOOGLE_MAPS_API_KEY ? 'env' : storedKey(db) ? 'app' : null,
			hint: key ? key.slice(-4) : null
		},
		tiles: mapTiles(db)
	};
}

/**
 * Saves the key, encrypted, after a place search and a tile session with it both work;
 * otherwise throws saying which API the key is missing.
 */
export async function saveGoogleMapsKey(
	db: Db,
	apiKey: string,
	fetchImpl: FetchImpl = fetch
): Promise<void> {
	const check = async (api: string, run: () => Promise<unknown>) => {
		try {
			await run();
		} catch (e) {
			const hint =
				e instanceof GoogleMapsError && e.rejected
					? ` Check the key, and that ${api} is enabled for its project.`
					: '';
			throw new Error(`${e instanceof Error ? e.message : String(e)}.${hint}`, { cause: e });
		}
	};
	await check('Places API (New)', () => verifyPlacesKey(apiKey, fetchImpl));
	await check('Map Tiles API', () => createTileSession(apiKey, {}, fetchImpl));
	setSetting(db, KEY_SETTING, encryptSecret(apiKey));
	tileSession = null;
}

export function clearGoogleMapsKey(db: Db): void {
	deleteSetting(db, KEY_SETTING);
	tileSession = null;
}

// ── Place photos ─────────────────────────────────────────────────────────────

/**
 * Photo names Places returned to each user, so `/api/maps/photo/<id>` serves only
 * photos from that user's own searches and never fetches a name a model made up.
 * Kept in memory: Google's terms don't allow storing them, and they expire anyway.
 */
const photos = new Map<string, { name: string; users: Set<string>; expiresAt: number }>();
const PHOTO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PHOTOS = 5000;
export const PHOTO_PATH = '/api/maps/photo/';

function rememberPhoto(name: string, userId: string, now = Date.now()): string {
	const id = createHash('sha256').update(name).digest('base64url').slice(0, 22);
	const entry = photos.get(id);
	if (entry) {
		entry.users.add(userId);
		entry.expiresAt = now + PHOTO_TTL_MS;
	} else {
		if (photos.size >= MAX_PHOTOS) photos.delete(photos.keys().next().value!);
		photos.set(id, { name, users: new Set([userId]), expiresAt: now + PHOTO_TTL_MS });
	}
	return `${PHOTO_PATH}${id}`;
}

/** The Google photo name behind an id, when the user's own search returned it. */
export function photoName(id: string, userId: string, now = Date.now()): string | null {
	const entry = photos.get(id);
	if (!entry || entry.expiresAt < now) {
		if (entry) photos.delete(id);
		return null;
	}
	return entry.users.has(userId) ? entry.name : null;
}

const PHOTO_WIDTH = 480;

export async function loadPlacePhoto(
	db: Db,
	name: string,
	fetchImpl: FetchImpl = fetch
): Promise<Image | null> {
	const key = getGoogleMapsKey(db);
	if (!key) return null;
	return fetchPlacePhoto(key, name, PHOTO_WIDTH, fetchImpl);
}

/** Google place search; photos come back as Chatty URLs only `userId` can load. */
export function searchPlacesWithGoogle(
	db: Db,
	query: PlaceQuery,
	userId: string | undefined,
	fetchImpl: FetchImpl = fetch
): Promise<Place[]> {
	const key = getGoogleMapsKey(db);
	if (!key) throw new Error('place search needs a Google Maps API key');
	return searchGooglePlaces(
		key,
		query,
		// Without a user nobody could load the photos, so they're left out.
		{ photoUrl: (name) => (userId ? rememberPhoto(name, userId) : null) },
		fetchImpl
	);
}

// ── Map tiles ────────────────────────────────────────────────────────────────

/** Renewed an hour before Google expires it. */
const SESSION_MARGIN_MS = 60 * 60 * 1000;
let tileSession: { key: string; session: Promise<TileSession> } | null = null;

async function currentSession(key: string, fetchImpl: FetchImpl): Promise<string> {
	if (tileSession?.key === key) {
		const s = await tileSession.session.catch(() => null);
		if (s && s.expiresAt - SESSION_MARGIN_MS > Date.now()) return s.session;
	}
	const session = createTileSession(key, {}, fetchImpl);
	tileSession = { key, session };
	try {
		return (await session).session;
	} catch (e) {
		// Don't keep a failed session around; the next tile asks again.
		if (tileSession?.session === session) tileSession = null;
		throw e;
	}
}

export async function loadTile(
	db: Db,
	z: number,
	x: number,
	y: number,
	fetchImpl: FetchImpl = fetch
): Promise<Image | null> {
	const key = getGoogleMapsKey(db);
	if (!key) return null;
	return fetchTile(key, await currentSession(key, fetchImpl), z, x, y, fetchImpl);
}

export async function loadCopyright(
	db: Db,
	view: Viewport,
	fetchImpl: FetchImpl = fetch
): Promise<string | null> {
	const key = getGoogleMapsKey(db);
	if (!key) return null;
	return fetchCopyright(key, await currentSession(key, fetchImpl), view, fetchImpl);
}

/** For tests: forget the cached tile session and photo names. */
export function resetMapsState(): void {
	tileSession = null;
	photos.clear();
}
