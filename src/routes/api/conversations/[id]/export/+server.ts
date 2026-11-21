import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	exportFileName,
	formatConversationExport,
	loadConversationExport
} from '$lib/server/chat/export.js';
import type { RequestHandler } from './$types';

/** The whole conversation as one Markdown file, for debugging and AI analysis. */
export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const data = loadConversationExport(getDb(), user.id, params.id);
	if (!data) error(404, { message: 'Conversation not found' });
	const now = Date.now();
	const name = exportFileName(data.conversation, now);
	return new Response(formatConversationExport(data, now), {
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'content-disposition': `attachment; filename="${name}"`,
			'cache-control': 'no-store'
		}
	});
};
