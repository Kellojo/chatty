import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { buildTools } from '$lib/server/tools/registry.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	const { tools, toolToServer, close } = await buildTools({
		userId: user.id,
		memoryEnabled: true
	});
	try {
		return json({
			tools: Object.entries(tools)
				.map(([name, tool]) => ({
					name,
					description: (tool.description as string) ?? '',
					server: toolToServer[name] ?? ''
				}))
				.sort((a, b) => a.name.localeCompare(b.name))
		});
	} finally {
		await close();
	}
};
