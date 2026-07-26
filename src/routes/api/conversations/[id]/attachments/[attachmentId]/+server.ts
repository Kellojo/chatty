import fs from 'node:fs';
import path from 'node:path';
import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import { getAttachment } from '$lib/server/db/repo/attachments.js';
import { resolveAttachment } from '$lib/server/workspaces.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	if (!getConversation(db, user.id, params.id)) error(404, { message: 'Conversation not found' });
	const row = getAttachment(db, params.attachmentId);
	const expectedPrefix = `${params.id}/attachments/`;
	const normalized = row?.path.split(path.sep).join('/');
	if (!row || !normalized?.startsWith(expectedPrefix)) {
		error(404, { message: 'Attachment not found' });
	}
	let filePath: string;
	try {
		filePath = resolveAttachment(row.path);
	} catch {
		error(404, { message: 'Attachment missing on disk' });
	}
	const bytes = fs.readFileSync(filePath!);
	return new Response(new Uint8Array(bytes), {
		headers: {
			'content-type': row.mime,
			'content-length': String(bytes.length),
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
};
