import { json, error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	deleteCodingEnvironment,
	getCodingEnvironment,
	toPublic,
	updateCodingEnvironment
} from '$lib/server/db/repo/coding-environments.js';
import { T3ClientError } from '$lib/server/t3/client.js';
import { environmentPatchSchema, resolveEnvironmentConnection } from '$lib/server/t3/input.js';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const parsed = environmentPatchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const db = getDb();
	const existing = getCodingEnvironment(db, user.id, params.id);
	if (!existing) error(404, { message: 'Environment not found' });

	const { baseUrl, token, pairingToken, ...rest } = parsed.data;
	let connection: { baseUrl: string | undefined; token: string | undefined } = {
		baseUrl: baseUrl?.baseUrl,
		token
	};
	// A pasted pairing link (or explicit pairing token) re-pairs against the new
	// or current URL and replaces the stored token.
	if (!token && (pairingToken || baseUrl?.pairingToken)) {
		try {
			connection = await resolveEnvironmentConnection({
				baseUrl: baseUrl ?? { baseUrl: existing.base_url, pairingToken: null },
				pairingToken
			});
		} catch (e) {
			if (e instanceof T3ClientError) error(400, { message: e.message });
			throw e;
		}
	}

	const row = updateCodingEnvironment(db, user.id, params.id, {
		...rest,
		baseUrl: connection.baseUrl,
		token: connection.token
	});
	if (!row) error(404, { message: 'Environment not found' });
	return json({ environment: toPublic(row) });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!deleteCodingEnvironment(getDb(), user.id, params.id)) {
		error(404, { message: 'Environment not found' });
	}
	return json({ ok: true });
};
