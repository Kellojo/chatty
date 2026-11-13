// Serves the pages coding agents publish with T3 Code's `html_render` tool
// (see $lib/html-render.ts). T3's stored copy is preferred: it has the agent's
// local images inlined and T3's bootstrap injected. When T3 can't provide it
// (machine offline, environment removed, page expired) the page is rebuilt
// from the tool call's own HTML with an equivalent bootstrap.

import {
	HOST_CONTEXT_CHANGED_METHOD,
	OPEN_LINK_METHOD,
	SIZE_CHANGED_METHOD,
	inlineHtml,
	isHtmlRenderToolName,
	readHtmlRender
} from '$lib/html-render.js';
import { decryptSecret } from '../crypto.js';
import type { Db } from '../db/index.js';
import { getCodingConversationForUser } from '../db/repo/coding-conversations.js';
import { getCodingEnvironment } from '../db/repo/coding-environments.js';
import { createLogger } from '../logger.js';
import { t3FetchBinary, type T3Connection } from './client.js';
import { acquireT3Connection } from './pool.js';
import { CodingTaskError } from './tasks.js';

const log = createLogger('t3-html-render');

const MAX_PAGE_BYTES = 10 * 1024 * 1024;

/**
 * The page runs in a sandbox without `allow-same-origin`, so it gets an opaque
 * origin even though Chatty serves it: it can't read Chatty's cookies, storage
 * or DOM, and its requests to Chatty are cross-site (SameSite cookies aren't
 * sent). Scripts may load from anywhere, as on T3, so pages can use CDNs.
 * Only Chatty may frame it; it can't navigate the top window or open popups.
 */
export const HTML_RENDER_CSP =
	"sandbox allow-scripts allow-forms allow-downloads; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

export interface HtmlRenderPage {
	html: string;
	source: 't3' | 'local';
}

interface StoredPart {
	type?: string;
	toolName?: string;
	toolCallId?: string;
	state?: string;
	input?: unknown;
	output?: unknown;
}

/** The `html_render` call `toolCallId` in the conversation's assistant messages. */
function findPart(db: Db, conversationId: string, toolCallId: string): StoredPart | null {
	const needle = JSON.stringify(toolCallId).slice(1, -1);
	const rows = db
		.prepare(
			`SELECT parts FROM messages
			 WHERE conversation_id = ? AND role = 'assistant' AND instr(parts, ?) > 0`
		)
		.all(conversationId, needle) as { parts: string }[];
	for (const { parts } of rows) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(parts);
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) continue;
		const part = (parsed as StoredPart[]).find(
			(p) => p?.toolCallId === toolCallId && isHtmlRenderToolName(p.toolName)
		);
		if (part) return part;
	}
	return null;
}

export async function fetchHtmlRenderPage(
	db: Db,
	userId: string,
	conversationId: string,
	toolCallId: string
): Promise<HtmlRenderPage> {
	const coding = getCodingConversationForUser(db, userId, conversationId);
	if (!coding) throw new CodingTaskError(404, 'Coding task not found');
	const part = findPart(db, conversationId, toolCallId);
	const ref = part ? readHtmlRender({ ...part, type: part.type ?? '' }) : null;
	if (!part || !ref) throw new CodingTaskError(404, 'Page not found');

	if (ref.attachmentId && coding.environment_id) {
		const env = getCodingEnvironment(db, userId, coding.environment_id);
		if (env && env.enabled === 1) {
			try {
				const html = await fetchFromT3(env, ref.attachmentId);
				if (html !== null) return { html, source: 't3' };
			} catch (e) {
				log.warn('Could not load an HTML render from T3; using the tool input', {
					conversationId,
					error: e instanceof Error ? e.message : String(e)
				});
			}
		}
	}
	const html = inlineHtml(part);
	if (!html) throw new CodingTaskError(404, 'This page is no longer available from T3 Code');
	return { html: injectHtmlRenderBootstrap(html), source: 'local' };
}

async function fetchFromT3(
	env: NonNullable<ReturnType<typeof getCodingEnvironment>>,
	attachmentId: string
): Promise<string | null> {
	let relativeUrl: string | null;
	const lease = acquireT3Connection(env);
	try {
		const conn: T3Connection = await lease.connection();
		const result = await conn.call<{ relativeUrl?: unknown }>('assets.createUrl', {
			resource: {
				_tag: 'attachment',
				attachmentId,
				mimeType: 'text/html',
				disposition: 'inline'
			}
		});
		relativeUrl = typeof result?.relativeUrl === 'string' ? result.relativeUrl : null;
	} finally {
		lease.release();
	}
	// Signed URLs are always same-server paths; refuse anything else.
	if (!relativeUrl || !relativeUrl.startsWith('/api/assets/')) return null;
	const file = await t3FetchBinary(
		env.base_url,
		decryptSecret(env.token_enc),
		relativeUrl,
		MAX_PAGE_BYTES
	);
	if (!file || !file.contentType.toLowerCase().startsWith('text/html')) return null;
	return new TextDecoder().decode(file.bytes);
}

// ── fallback bootstrap ───────────────────────────────────────────────────
// Mirrors what T3 injects into stored pages: the base sheet, theme updates
// from the host, auto height, and opening http(s) links through the host.

const BASE_CSS =
	'html{box-sizing:border-box;padding:8px;background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}:where(:focus-visible){outline:2px solid var(--ring)}';

/** Until the host sends its theme. */
const DEFAULT_CSS = `:root{color-scheme:light dark;--background:transparent;--foreground:CanvasText;--font-sans:system-ui,sans-serif;--font-mono:ui-monospace,monospace;--radius:0.625rem}${BASE_CSS}`;

const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById("t3-theme"),n=0,P=window.parent!==window?window.parent:null;if(!s)return;var b=${JSON.stringify(BASE_CSS)};function a(t){if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>\\\\]/g,"")+";";}s.textContent=c+"}"+b;}window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(e.source===P&&d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&p&&p.styles)a({appearance:p.theme,variables:p.styles.variables});});if(!P)return;document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;e.preventDefault();P.postMessage({jsonrpc:"2.0",id:"t3-link-"+(++n),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:u.href}},"*");},true);var h,o,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;P.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED_METHOD)},params:{height:v}},"*");};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);})();`;

function bootstrapMarkup(scan: string): string {
	return [
		/<meta\s[^>]*charset/i.test(scan.slice(0, 4096)) ? '' : '<meta charset="utf-8">',
		/<meta\s[^>]*name\s*=\s*["']?viewport/i.test(scan)
			? ''
			: '<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<style id="t3-theme">${DEFAULT_CSS}</style>`,
		`<script>${BOOTSTRAP_SCRIPT}</script>`
	].join('');
}

/** `html` with comments and raw-text elements blanked, so tags inside them don't match. */
function blankNonMarkup(html: string): string {
	return html.replace(
		/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
		(match) => ' '.repeat(match.length)
	);
}

/** Inserts the bootstrap at the start of the page's head (adding one if missing). */
export function injectHtmlRenderBootstrap(html: string): string {
	const scan = blankNonMarkup(html);
	const markup = bootstrapMarkup(scan);
	const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
	if (headOpen) {
		const at = headOpen.index + headOpen[0].length;
		return html.slice(0, at) + markup + html.slice(at);
	}
	const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
	if (htmlOpen) {
		const at = htmlOpen.index + htmlOpen[0].length;
		return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
	}
	const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
	if (doctype) {
		const at = doctype[0].length;
		return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
	}
	return `<!doctype html><head>${markup}</head>${html}`;
}
