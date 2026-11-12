import { json, error } from '@sveltejs/kit';
import { failCodingAgentRunForTask } from '$lib/server/agents/coding-runs.js';
import { requireUser } from '$lib/server/auth/guards.js';
import { publishServerEvent } from '$lib/server/events/bus.js';
import { getDb } from '$lib/server/db/index.js';
import {
	listLiveCodingConversations,
	updateCodingConversation
} from '$lib/server/db/repo/coding-conversations.js';
import {
	deleteCodingEnvironment,
	getCodingEnvironment,
	toPublic,
	updateCodingEnvironment
} from '$lib/server/db/repo/coding-environments.js';
import { T3ClientError } from '$lib/server/t3/client.js';
import {
	environmentPatchSchema,
	identifyEnvironment,
	rejectDuplicateEnvironment,
	resolveEnvironmentConnection
} from '$lib/server/t3/input.js';
import { applyEnvironmentChange, syncCodingEnvironment } from '$lib/server/t3/sync.js';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const parsed = environmentPatchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const db = getDb();
	const existing = getCodingEnvironment(db, user.id, params.id);
	if (!existing) error(404, { message: 'Environment not found' });

	const { baseUrl, token, pairingToken, ...rest } = parsed.data;
	// Moving to another URL must not make this a second copy of a connected
	// server. Checked before pairing, which spends the single-use token.
	const newBaseUrl = baseUrl && baseUrl.baseUrl !== existing.base_url ? baseUrl.baseUrl : undefined;
	let remoteEnvironmentId: string | null | undefined;
	if (newBaseUrl) {
		rejectDuplicateEnvironment(db, user.id, { baseUrl: newBaseUrl }, existing.id);
		remoteEnvironmentId = await identifyEnvironment(newBaseUrl);
		rejectDuplicateEnvironment(
			db,
			user.id,
			{ baseUrl: newBaseUrl, remoteEnvironmentId },
			existing.id
		);
	}
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

	if (newBaseUrl) {
		// Re-checked after the awaits above: another request may have added it.
		rejectDuplicateEnvironment(
			db,
			user.id,
			{ baseUrl: newBaseUrl, remoteEnvironmentId },
			existing.id
		);
	}
	const row = updateCodingEnvironment(db, user.id, params.id, {
		...rest,
		baseUrl: connection.baseUrl,
		token: connection.token,
		...(remoteEnvironmentId ? { remoteEnvironmentId } : {})
	});
	if (!row) error(404, { message: 'Environment not found' });
	const connectionChanged =
		row.base_url !== existing.base_url || row.token_enc !== existing.token_enc;
	const disabled = existing.enabled === 1 && row.enabled !== 1;
	const enabled = existing.enabled !== 1 && row.enabled === 1;
	if (disabled) {
		// The remote agents keep working; their tasks resume when re-enabled.
		applyEnvironmentChange(db, row.id, DISABLED_ERROR);
		for (const task of listLiveCodingConversations(db)) {
			if (task.environment_id !== row.id) continue;
			updateCodingConversation(db, task.conversation_id, { lastError: DISABLED_ERROR });
			publishServerEvent(user.id, {
				type: 'coding.task.updated',
				conversationId: task.conversation_id
			});
		}
	} else if (connectionChanged || enabled) {
		applyEnvironmentChange(db, row.id);
	}
	// Check the new connection right away, as when adding an environment.
	const refreshed =
		row.enabled === 1 && (connectionChanged || enabled)
			? await syncCodingEnvironment(db, row)
			: row;
	return json({ environment: toPublic(refreshed) });
};

const DISABLED_ERROR = 'The coding environment is disabled. Enable it to continue.';

const REMOVED_ERROR = 'The coding environment was removed';

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const deleted = deleteCodingEnvironment(db, user.id, params.id);
	if (!deleted) error(404, { message: 'Environment not found' });
	// Ends replies still streaming from its tasks (without touching the remote
	// runs) and closes every connection that used its URL and token.
	applyEnvironmentChange(db, params.id, REMOVED_ERROR);
	for (const id of deleted.endedIds) failCodingAgentRunForTask(id, REMOVED_ERROR, db);
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
