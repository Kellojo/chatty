import { json, error } from '@sveltejs/kit';
import { failCodingAgentRunForTask } from '$lib/server/agents/coding-runs.js';
import { requireUser } from '$lib/server/auth/guards.js';
import { abortStream } from '$lib/server/chat/streams.js';
import { publishServerEvent } from '$lib/server/events/bus.js';
import { getDb } from '$lib/server/db/index.js';
import {
	deleteCodingEnvironment,
	getCodingEnvironment,
	toPublic,
	updateCodingEnvironment
} from '$lib/server/db/repo/coding-environments.js';
import { T3ClientError } from '$lib/server/t3/client.js';
import { stopFollowersForEnvironment } from '$lib/server/t3/follower.js';
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

	// The stored token must never be sent to a different host: moving an
	// environment to a new origin requires a new token or pairing link.
	if (
		connection.baseUrl &&
		!connection.token &&
		new URL(connection.baseUrl).origin !== new URL(existing.base_url).origin
	) {
		error(400, { message: 'Changing the URL requires a new token or pairing link' });
	}

	const row = updateCodingEnvironment(db, user.id, params.id, {
		...rest,
		baseUrl: connection.baseUrl,
		token: connection.token
	});
	if (!row) error(404, { message: 'Environment not found' });
	if (
		row.base_url !== existing.base_url ||
		row.token_enc !== existing.token_enc ||
		(existing.enabled === 1 && row.enabled !== 1)
	) {
		stopFollowersForEnvironment(row.id);
	}
	return json({ environment: toPublic(row) });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const deleted = deleteCodingEnvironment(db, user.id, params.id);
	if (!deleted) error(404, { message: 'Environment not found' });
	stopFollowersForEnvironment(params.id);
	// Its tasks were marked as done; stop anything still streaming from them.
	for (const id of deleted.endedIds) {
		abortStream(id);
		failCodingAgentRunForTask(id, 'The coding environment was removed', db);
	}
	if (deleted.settledIds.length > 0) {
		publishServerEvent(user.id, {
			type: 'conversation.settle_changed',
			conversationIds: deleted.settledIds,
			settled: true
		});
	}
	for (const id of deleted.taskIds) {
		publishServerEvent(user.id, { type: 'coding.task.updated', conversationId: id });
	}
	return json({ ok: true });
};
