// T3 Code's `html_render` tool: a coding agent publishes an HTML page that the
// chat shows inline. The tool call's input holds the page (`title`, `height`,
// `html`); its output references T3's stored copy (`htmlRender`), which T3
// prepared for display (local images inlined, its bootstrap script injected).
//
// Chatty serves the page from its own origin under a CSP sandbox (an opaque
// origin: no access to Chatty's cookies, storage or DOM) and talks to it with
// the same postMessage protocol T3 uses, so T3's stored pages work unchanged.

export const HTML_RENDER_MIN_HEIGHT = 80;
/** Cap on the height published with the page. */
export const HTML_RENDER_MAX_HEIGHT = 2000;
/** Cap on heights the page reports while shown (content can grow past the published one). */
export const HTML_RENDER_MAX_FIT_HEIGHT = 20_000;

/** Messages between the frame and Chatty (T3 Code's host protocol). */
export const HOST_CONTEXT_CHANGED_METHOD = 'ui/notifications/host-context-changed';
export const SIZE_CHANGED_METHOD = 'ui/notifications/size-changed';
export const OPEN_LINK_METHOD = 'ui/open-link';

export interface HtmlRenderRef {
	title: string;
	height: number;
	/** Content heights T3 measured per frame width, ascending by width. */
	heights: [number, number][];
	attachmentId: string | null;
}

interface ToolPartLike {
	type: string;
	toolName?: string;
	state?: string;
	input?: unknown;
	output?: unknown;
}

const rec = (v: unknown): Record<string, unknown> | null =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Tool names differ per agent (`mcp__t3-code__html_render`, `t3-code.html_render`, …). */
export function isHtmlRenderToolName(name: string | undefined): boolean {
	return !!name && /(?:^|[_.:/-])html_render$/.test(name);
}

export function clampHtmlRenderHeight(height: number, max = HTML_RENDER_MAX_HEIGHT): number {
	return Math.min(max, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));
}

function parseOutput(output: unknown): Record<string, unknown> | null {
	if (typeof output !== 'string') return rec(output);
	try {
		return rec(JSON.parse(output));
	} catch {
		return null;
	}
}

/** The page of a finished, successful `html_render` call, or null for any other part. */
export function readHtmlRender(part: ToolPartLike): HtmlRenderRef | null {
	if (part.type !== 'dynamic-tool' || !isHtmlRenderToolName(part.toolName)) return null;
	if (part.state !== 'output-available') return null;
	const input = rec(part.input);
	if (typeof input?.html !== 'string' || input.html.trim() === '') return null;
	const ref = rec(parseOutput(part.output)?.htmlRender);
	// No reference means T3 refused the page (the output is an error message).
	if (!ref) return null;
	const title = typeof ref.title === 'string' ? ref.title : input.title;
	const height = typeof ref.height === 'number' ? ref.height : input.height;
	const attachmentId = ref.attachmentId;
	return {
		title: (typeof title === 'string' ? title.trim().slice(0, 200) : '') || 'HTML',
		height: clampHtmlRenderHeight(
			typeof height === 'number' && Number.isFinite(height) ? height : 400
		),
		heights: readHeights(ref.heights),
		attachmentId:
			typeof attachmentId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(attachmentId)
				? attachmentId
				: null
	};
}

function readHeights(value: unknown): [number, number][] {
	if (!Array.isArray(value)) return [];
	return value
		.flatMap((entry): [number, number][] =>
			Array.isArray(entry) &&
			Number.isInteger(entry[0]) &&
			entry[0] > 0 &&
			typeof entry[1] === 'number' &&
			Number.isFinite(entry[1])
				? [[entry[0], clampHtmlRenderHeight(entry[1])]]
				: []
		)
		.sort((a, b) => a[0] - b[0])
		.slice(0, 24);
}

/** The best guess at the page's height at `width` before it reports its own. */
export function htmlRenderHeightAt(ref: HtmlRenderRef, width: number): number {
	if (ref.heights.length === 0 || width <= 0) return ref.height;
	let best = ref.heights[0];
	for (const entry of ref.heights) if (entry[0] <= width) best = entry;
	return best[1];
}

/** Characters that could end a declaration or the style element. */
const UNSAFE_CSS_VALUE = /[;{}<>\\]/g;

/** A theme message for the frame. Values are sanitized again inside the frame. */
export function hostContextMessage(
	appearance: 'light' | 'dark',
	variables: Record<string, string>
) {
	const clean: Record<string, string> = {};
	for (const [name, value] of Object.entries(variables)) {
		if (/^--[a-z0-9-]+$/.test(name) && value) clean[name] = value.replace(UNSAFE_CSS_VALUE, '');
	}
	return {
		jsonrpc: '2.0',
		method: HOST_CONTEXT_CHANGED_METHOD,
		params: { theme: appearance, styles: { variables: clean } }
	};
}
