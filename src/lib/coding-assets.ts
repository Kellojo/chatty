/**
 * Images a coding agent saved on its own machine show up in replies as local
 * paths (`C:\…\shot.png`, `/home/me/shot.png`). Browsers can't load those, so
 * Chatty serves them through the T3 server: see `/api/coding/tasks/[id]/asset`.
 */

/** Raster formats only: SVG can carry script and isn't worth the risk here. */
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

/**
 * Absolute local paths: drive letters, UNC shares, `~` and POSIX filesystem
 * roots. App-relative URLs like `/pwa-192x192.png` must not match.
 */
const LOCAL_PATH =
	/^(?:[a-z]:[\\/]|\\\\|~[\\/]|\/(?:home|Users|tmp|var|private|mnt|opt|root|srv|Volumes)\/)/i;

export function isLocalImagePath(src: string): boolean {
	return LOCAL_PATH.test(src) && IMAGE_EXTENSION.test(src) && !src.includes('\0');
}

export function codingAssetUrl(conversationId: string, path: string): string {
	return `/api/coding/tasks/${encodeURIComponent(conversationId)}/asset?path=${encodeURIComponent(path)}`;
}
