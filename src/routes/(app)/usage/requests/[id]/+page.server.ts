import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getProxyRequest, toPublic } from '$lib/server/db/repo/proxy-requests.js';
import { getTimeFormat } from '$lib/server/db/repo/user-settings.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const isAdmin = (user as { role?: string }).role === 'admin';
	const db = getDb();
	const row = getProxyRequest(db, params.id);
	// Non-admins may only open their own requests; others look like they don't exist.
	if (!row || (!isAdmin && row.user_id !== user.id)) error(404, { message: 'Request not found' });
	const request = toPublic(row);

	const userRow = db.prepare('SELECT name, email FROM "user" WHERE id = ?').get(request.userId) as
		{ name: string; email: string } | undefined;
	const userName = userRow ? userRow.name || userRow.email : request.userId;

	let keyLabel: string | null = null;
	if (request.apiKeyId) {
		const keyRow = db.prepare('SELECT label FROM api_keys WHERE id = ?').get(request.apiKeyId) as
			{ label: string } | undefined;
		keyLabel = keyRow?.label ?? null;
	}

	// Show the provider's name, not its id (the id stays available as a tooltip).
	const providerName = request.providerId
		? ((
				db.prepare('SELECT name FROM providers WHERE id = ?').get(request.providerId) as
					{ name: string } | undefined
			)?.name ?? null)
		: null;

	// Admins can see others' requests, but /chat only opens the viewer's own conversations.
	const conversationOpenable = request.conversationId
		? db
				.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
				.get(request.conversationId, user.id) !== undefined
		: false;

	let mappingName: string | null = null;
	if (request.mappingId) {
		const mappingRow = db
			.prepare('SELECT name FROM model_mappings WHERE id = ?')
			.get(request.mappingId) as { name: string } | undefined;
		mappingName = mappingRow?.name ?? null;
	}

	return {
		request,
		userName,
		keyLabel,
		providerName,
		conversationOpenable,
		mappingName,
		timeFormat: getTimeFormat(db, user.id)
	};
};
