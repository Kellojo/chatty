import fsp from 'node:fs/promises';
import path from 'node:path';
import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import { fileResponse } from '$lib/server/http/fileResponse.js';
import { contentDisposition, untrustedFileHeaders } from '$lib/server/http/untrustedFile.js';
import { resolveInsideReal } from '$lib/server/safePath.js';
import { workspaceForConversation } from '$lib/server/workspaces.js';
import type { RequestHandler } from './$types';

const MIME_MAP: Record<string, string> = {
	'.html': 'text/html',
	'.css': 'text/css',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.cjs': 'text/javascript',
	'.ts': 'text/typescript',
	'.mts': 'text/typescript',
	'.cts': 'text/typescript',
	'.jsx': 'text/javascript',
	'.tsx': 'text/typescript',
	'.json': 'application/json',
	'.xml': 'application/xml',
	'.svg': 'image/svg+xml',
	'.md': 'text/markdown',
	'.csv': 'text/csv',
	'.yaml': 'text/yaml',
	'.yml': 'text/yaml',
	'.sql': 'text/sql',
	'.graphql': 'application/graphql',
	'.py': 'text/x-python',
	'.sh': 'text/x-shellscript',
	'.pdf': 'application/pdf',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.mp3': 'audio/mpeg',
	'.mp4': 'video/mp4',
	'.zip': 'application/zip',
	'.tar': 'application/x-tar',
	'.gz': 'application/gzip'
};

export const GET: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const db = getDb();
	const conversation = getConversation(db, user.id, params.id);
	if (!conversation) error(404, { message: 'Conversation not found' });

	const filePath = params.path;
	if (!filePath) error(400, { message: 'No file path specified' });

	const workspaceDir = workspaceForConversation(db, conversation);
	if (!workspaceDir) error(404, { message: 'File not found' });
	// Resolves symlinks too, so a link planted in the workspace can't expose
	// files outside it. A missing workspace also resolves to null.
	const abs = await resolveInsideReal(workspaceDir, filePath);
	if (!abs) error(404, { message: 'File not found' });

	const stat = await fsp.stat(abs).catch(() => null);
	if (!stat) error(404, { message: 'File not found' });

	if (stat.isDirectory()) {
		error(400, { message: 'Path is a directory' });
	}

	const ext = path.extname(filePath).toLowerCase();
	const mime = MIME_MAP[ext] ?? 'application/octet-stream';
	const disposition =
		mime.startsWith('text/') || mime === 'application/json' ? 'inline' : 'attachment';

	// Agents rewrite workspace files, so browsers must revalidate (a cheap 304
	// via ETag / Last-Modified) rather than cache them for a fixed time.
	return fileResponse(abs, request, {
		...untrustedFileHeaders(mime),
		'content-type': mime,
		'content-disposition': contentDisposition(disposition, path.basename(filePath)),
		'cache-control': 'private, no-cache'
	}).catch(() => error(404, { message: 'File not found' }));
};
