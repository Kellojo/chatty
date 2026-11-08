import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { json, error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { config } from '$lib/server/config.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import { createAttachment } from '$lib/server/db/repo/attachments.js';
import { getSetting } from '$lib/server/db/repo/settings.js';
import { ensureAttachmentsDir, sanitizeFilename } from '$lib/server/workspaces.js';
import type { RequestHandler } from './$types';

// Room for the multipart boundaries and part headers around the file itself.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const db = getDb();
	if (!getConversation(db, user.id, params.id)) error(404, { message: 'Conversation not found' });

	const maxMb = getSetting<number>(db, 'attachments.maxSizeMb') ?? config.MAX_ATTACHMENT_SIZE_MB;
	const maxBytes = maxMb * 1024 * 1024;
	const tooLarge = () => error(413, { message: `File exceeds the ${maxMb} MB limit` });
	// Reject oversized uploads before buffering the whole body.
	const contentLength = Number(request.headers.get('content-length'));
	if (contentLength > maxBytes + MULTIPART_OVERHEAD_BYTES) tooLarge();
	const form = await request.formData();
	const file = form.get('file');
	if (!(file instanceof File)) error(400, { message: 'Missing file field "file"' });
	if (file.size > maxBytes) tooLarge();

	const bytes = Buffer.from(await file.arrayBuffer());
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	const storedName = `${randomUUID()}-${sanitizeFilename(file.name)}`;
	const dir = await ensureAttachmentsDir(params.id);
	await fs.writeFile(path.join(dir, storedName), bytes);

	const relativePath = path.join(params.id, 'attachments', storedName);
	const mime = file.type || 'application/octet-stream';
	const row = createAttachment(db, {
		kind: mime.startsWith('image/') ? 'image' : 'file',
		path: relativePath,
		mime,
		sha256
	});
	return json(
		{
			attachment: {
				id: row.id,
				url: `/api/conversations/${params.id}/attachments/${row.id}`,
				mime: row.mime,
				kind: row.kind,
				name: file.name
			}
		},
		{ status: 201 }
	);
};
