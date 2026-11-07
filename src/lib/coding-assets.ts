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

/** `![alt](dest` with the destination bare or in angle brackets. */
const IMAGE_DESTINATION = /(!\[[^\]\n]*\]\(\s*)(<[^>\n]*>|[^\s)]+)/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(`+)[^`]*?\1/g;

function escapeDestination(match: string, prefix: string, dest: string): string {
	const bare = dest.startsWith('<') ? dest.slice(1, -1) : dest;
	if (!bare.includes('\\') || !isLocalImagePath(bare)) return match;
	// Already escaped by the writer: every backslash is doubled.
	if (!/(?<!\\)\\(?!\\)/.test(bare) && /\\\\/.test(bare)) return match;
	return prefix + dest.replaceAll('\\', '\\\\');
}

/**
 * Markdown treats `\.` and similar as escapes, so `C:\me\.t3\a.png` would
 * parse as `C:\me.t3\a.png`. Agents write Windows paths raw, so double the
 * backslashes in local image destinations (outside code) before parsing.
 */
export function escapeLocalImagePaths(markdown: string): string {
	if (!markdown.includes('\\') || !markdown.includes('![')) return markdown;
	let fence: string | null = null;
	return markdown
		.split('\n')
		.map((line) => {
			const marker = line.match(FENCE)?.[1];
			if (fence) {
				if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
				return line;
			}
			if (marker) {
				fence = marker;
				return line;
			}
			let out = '';
			let last = 0;
			for (const code of line.matchAll(INLINE_CODE)) {
				out += line.slice(last, code.index).replace(IMAGE_DESTINATION, escapeDestination);
				out += code[0];
				last = code.index + code[0].length;
			}
			return out + line.slice(last).replace(IMAGE_DESTINATION, escapeDestination);
		})
		.join('\n');
}
