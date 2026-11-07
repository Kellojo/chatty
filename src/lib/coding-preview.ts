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
