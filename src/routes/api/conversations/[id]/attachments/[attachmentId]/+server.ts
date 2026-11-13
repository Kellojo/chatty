import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import { getConversationAttachment } from '$lib/server/db/repo/attachments.js';
import { fileResponse } from '$lib/server/http/fileResponse.js';
import { untrustedFileHeaders } from '$lib/server/http/untrustedFile.js';
import { resolveAttachment } from '$lib/server/workspaces.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const db = getDb();
	if (!getConversation(db, user.id, params.id)) error(404, { message: 'Conversation not found' });
	const row = getConversationAttachment(db, params.id, params.attachmentId);
	if (!row) error(404, { message: 'Attachment not found' });
	let filePath: string;
	try {
		filePath = await resolveAttachment(row.path);
	} catch {
		error(404, { message: 'Attachment missing on disk' });
	}
	return fileResponse(filePath, request, {
		...untrustedFileHeaders(row.mime),
		'content-type': row.mime,
		'cache-control': 'private, max-age=31536000, immutable'
	}).catch(() => error(404, { message: 'Attachment missing on disk' }));
};
