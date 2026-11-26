import { requireAdmin, requireUser } from '$lib/server/auth/guards.js';
import { buildMemoryArchive, memoryArchiveFileName } from '$lib/server/memory/export.js';
import type { RequestHandler } from './$types';

/** The user's memory (or, for admins, shared memory with `?scope=shared`) as a zip of Markdown files. */
export const GET: RequestHandler = async ({ locals, url }) => {
	const scope = url.searchParams.get('scope') === 'shared' ? 'shared' : 'user';
	const user = scope === 'shared' ? requireAdmin(locals) : requireUser(locals);
	const { bytes } = await buildMemoryArchive(scope, user.id);
	return new Response(bytes as Uint8Array<ArrayBuffer>, {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': `attachment; filename="${memoryArchiveFileName(scope, Date.now())}"`,
			'cache-control': 'no-store'
		}
	});
};
