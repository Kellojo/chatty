import { error, isHttpError, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { clearGoogleMapsKey, getMapsInfo, saveGoogleMapsKey } from '$lib/server/maps/service.js';
import type { RequestHandler } from './$types';

const keySchema = z.object({ apiKey: z.string().trim().min(1).max(500) });

function refuseEnvKey(action: 'change' | 'remove') {
	if (getMapsInfo(getDb()).google.source === 'env') {
		error(409, { message: `The key is set by GOOGLE_MAPS_API_KEY; ${action} it there.` });
	}
}

/** Saves the Google Maps key (`{ apiKey }`, stored encrypted) once Places and Map Tiles accept it. */
export const PUT: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	refuseEnvKey('change');
	const parsed = keySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Enter an API key' });
	const db = getDb();
	try {
		await saveGoogleMapsKey(db, parsed.data.apiKey);
	} catch (e) {
		if (isHttpError(e)) throw e;
		error(400, { message: e instanceof Error ? e.message : 'Could not verify the key' });
	}
	return json(getMapsInfo(db));
};

export const DELETE: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	refuseEnvKey('remove');
	const db = getDb();
	clearGoogleMapsKey(db);
	return json(getMapsInfo(db));
};
