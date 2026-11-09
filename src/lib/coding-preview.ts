// Shared (client-safe) types for watching a coding agent's browser preview.
// T3 Code runs preview tabs in a browser on the coding machine and streams them
// as JPEG frames; Chatty relays that stream (see $lib/server/t3/preview.ts).

/** One browser tab the coding agent (or you, in T3) opened for a thread. */
export interface CodingPreviewTab {
	tabId: string;
	url: string | null;
	title: string | null;
	status: 'idle' | 'loading' | 'ready' | 'failed';
	/** Why the last navigation failed, when it did. */
	error: string | null;
	canGoBack: boolean;
	canGoForward: boolean;
}

/** Who is driving the tab, from the viewer's point of view. */
export type PreviewController = 'you' | 'another-viewer' | 'agent' | 'unclaimed';

/** State the stream reports besides frames. */
export type PreviewStreamEvent =
	| { type: 'ready'; viewerId: string }
	/** Layout size of the page in CSS pixels; pointer input uses these coordinates. */
	| { type: 'viewport'; width: number; height: number }
	| {
			type: 'control';
			/** False when the environment's token can't operate previews (re-pair it). */
			canOperate: boolean;
			controller: PreviewController;
	  }
	/** The page opened a popup tab. */
	| { type: 'popup'; tabId: string }
	| { type: 'end'; reason: PreviewEndReason; message: string };

/** `restart`: T3 restarted the tab's stream, so connecting again picks it up. */
export type PreviewEndReason = 'gone' | 'unavailable' | 'restart' | 'error';

/** Input batched per request; mouse moves are coalesced by the client. */
export const MAX_PREVIEW_INPUT_BATCH = 64;

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function previewModifiers(event: {
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}): number {
	return (
		(event.altKey ? 1 : 0) |
		(event.ctrlKey ? 2 : 0) |
		(event.metaKey ? 4 : 0) |
		(event.shiftKey ? 8 : 0)
	);
}

/**
 * Maps a point on the displayed frame to page coordinates. `rect` is the
 * rendered image, `viewport` the page's layout size.
 */
export function toPagePoint(
	clientX: number,
	clientY: number,
	rect: { left: number; top: number; width: number; height: number },
	viewport: { width: number; height: number }
): { x: number; y: number } {
	const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
	const x = rect.width > 0 ? ((clientX - rect.left) / rect.width) * viewport.width : 0;
	const y = rect.height > 0 ? ((clientY - rect.top) / rect.height) * viewport.height : 0;
	return { x: Math.round(clamp(x, viewport.width)), y: Math.round(clamp(y, viewport.height)) };
}

/** The largest size with `content`'s aspect ratio that fits in `box`. */
export function fitSize(
	content: { width: number; height: number },
	box: { width: number; height: number }
): { width: number; height: number } {
	if (content.width <= 0 || content.height <= 0 || box.width <= 0 || box.height <= 0) {
		return { width: 0, height: 0 };
	}
	const scale = Math.min(box.width / content.width, box.height / content.height);
	return {
		width: Math.round(content.width * scale),
		height: Math.round(content.height * scale)
	};
}

/**
 * The agent's latest use of its browser during a run. `calls` grows with every
 * browser tool call, so a change means the agent just used it again.
 */
export interface CodingBrowserActivity {
	/** Identifies the run, so dismissing the picture-in-picture lasts until the next one. */
	run: string;
	calls: number;
	/** The tab the latest call used, when it says. */
	tabId: string | null;
}

/** Browser tools that look at or drive a tab ("mcp__t3-code__preview_act"), not housekeeping. */
const BROWSER_TOOL = /(?:^|[_.:])preview_(?!close$|list$|status$)[a-z_]+$/;

export function isBrowserToolName(name: string): boolean {
	return BROWSER_TOOL.test(name);
}

interface ToolPartLike {
	type: string;
	toolName?: string;
	input?: unknown;
	output?: unknown;
}

const TAB_ID = /"tabId"\s*:\s*"([^"]{1,256})"/;

function tabIdOf(part: ToolPartLike): string | null {
	const input = part.input as { tabId?: unknown } | null | undefined;
	if (input && typeof input === 'object' && typeof input.tabId === 'string' && input.tabId) {
		return input.tabId;
	}
	// The result of opening a tab names it; only its start is needed.
	const output = typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? '');
	return TAB_ID.exec(output.slice(0, 4000))?.[1] ?? null;
}

/** The agent's browser activity in a message's parts, or null when it hasn't used the browser. */
export function browserActivity(
	parts: readonly ToolPartLike[],
	run: string
): CodingBrowserActivity | null {
	let calls = 0;
	let last: ToolPartLike | null = null;
	for (const part of parts) {
		const name =
			part.type === 'dynamic-tool'
				? (part.toolName ?? '')
				: part.type.startsWith('tool-')
					? part.type.slice(5)
					: '';
		if (!name || !isBrowserToolName(name)) continue;
		calls++;
		last = part;
	}
	return last ? { run, calls, tabId: tabIdOf(last) } : null;
}
