import { json, error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	MAX_CODING_ENVIRONMENTS_PER_USER,
	countCodingEnvironments,
	createCodingEnvironment,
	listCodingEnvironments,
	toPublic
} from '$lib/server/db/repo/coding-environments.js';
import { T3ClientError } from '$lib/server/t3/client.js';
import {
	environmentCreateSchema,
	probeRemoteEnvironmentId,
	rejectDuplicateEnvironment,
	resolveEnvironmentConnection
} from '$lib/server/t3/input.js';
import { syncCodingEnvironment } from '$lib/server/t3/sync.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json({ environments: listCodingEnvironments(getDb(), user.id).map(toPublic) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = environmentCreateSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const db = getDb();
	const checkLimit = () => {
		if (countCodingEnvironments(db, user.id) >= MAX_CODING_ENVIRONMENTS_PER_USER) {
			error(400, {
				message: `You can connect at most ${MAX_CODING_ENVIRONMENTS_PER_USER} coding environments. Remove one to add another.`
			});
		}
	};
	// Checked before contacting the server (a pairing token is single-use, so
	// don't spend it on a duplicate), and again before inserting.
	checkLimit();
	const baseUrl = parsed.data.baseUrl.baseUrl;
	rejectDuplicateEnvironment(db, user.id, { baseUrl });
	const remoteEnvironmentId = await probeRemoteEnvironmentId(baseUrl);
	rejectDuplicateEnvironment(db, user.id, { baseUrl, remoteEnvironmentId });
	let connection: Awaited<ReturnType<typeof resolveEnvironmentConnection>>;
	try {
		connection = await resolveEnvironmentConnection(parsed.data);
	} catch (e) {
		if (e instanceof T3ClientError) error(400, { message: e.message });
		throw e;
	}
	if (!connection.token) error(400, { message: 'Paste a pairing link or enter an access token' });
	checkLimit();
	rejectDuplicateEnvironment(db, user.id, { baseUrl: connection.baseUrl, remoteEnvironmentId });
	const row = createCodingEnvironment(db, user.id, {
		name: parsed.data.name,
		baseUrl: connection.baseUrl,
		token: connection.token,
		enabled: parsed.data.enabled,
		remoteEnvironmentId
	});
	// Connect right away so the user sees whether the URL and token work.
	const refreshed = row.enabled === 1 ? await syncCodingEnvironment(db, row) : row;
	return json({ environment: toPublic(refreshed) }, { status: 201 });
};
