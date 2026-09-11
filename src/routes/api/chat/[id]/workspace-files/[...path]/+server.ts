import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import { conversationWorkspace } from '$lib/server/workspaces.js';
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

export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	if (!getConversation(db, user.id, params.id)) error(404, { message: 'Conversation not found' });

	const filePath = params.path;
	if (!filePath) error(400, { message: 'No file path specified' });

	const workspaceDir = conversationWorkspace(params.id);
	const abs = path.resolve(workspaceDir, filePath);
	if (abs !== workspaceDir && !abs.startsWith(workspaceDir + path.sep)) {
		error(403, { message: 'Path escapes workspace' });
	}

	let stat: fs.Stats;
	try {
		stat = await fsp.stat(abs);
	} catch {
		error(404, { message: 'File not found' });
	}

	if (stat.isDirectory()) {
		error(400, { message: 'Path is a directory' });
	}

	const ext = path.extname(filePath).toLowerCase();
	const mime = MIME_MAP[ext] ?? 'application/octet-stream';
	const content = await fsp.readFile(abs);
	const disposition =
		mime.startsWith('text/') || mime === 'application/json' ? 'inline' : 'attachment';

	return new Response(new Uint8Array(content), {
		headers: {
			'content-type': mime,
			'content-length': String(stat.size),
			'content-disposition': `${disposition}; filename="${path.basename(filePath)}"`,
			'cache-control': 'private, max-age=3600'
		}
	});
};
