import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { HTML_RENDER_CSP, fetchHtmlRenderPage } from '$lib/server/t3/html-render.js';
import { CodingTaskError } from '$lib/server/t3/tasks.js';
import type { RequestHandler } from './$types';

const HEADERS = {
	'content-type': 'text/html; charset=utf-8',
	'content-security-policy': HTML_RENDER_CSP,
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
	'cache-control': 'private, no-store'
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Shown inside the frame (Chatty's own error page may not be framed). */
function errorPage(status: number, message: string): Response {
	const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:16px;font:13px system-ui,sans-serif;color:#888">${escapeHtml(message)}</body>`;
	return new Response(html, { status, headers: HEADERS });
}

/**
 * A page the coding agent published with `html_render` (`?call=<toolCallId>`),
 * for Chatty's sandboxed preview frame. See HTML_RENDER_CSP.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const user = requireUser(locals);
	const call = url.searchParams.get('call');
	if (!call || call.length > 512) return errorPage(400, 'Missing page reference');
	try {
		const page = await fetchHtmlRenderPage(getDb(), user.id, params.id, call);
		return new Response(page.html, { headers: HEADERS });
	} catch (e) {
		if (e instanceof CodingTaskError) return errorPage(e.status, e.message);
		throw e;
	}
};
