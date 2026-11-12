// Web Share Target: other apps share into Chatty with a POST to /share-target
// (manifest `share_target` in vite.config.ts). The service worker
// (static/share-target-sw.js) parks shared files in a cache and redirects to
// `/?share_title=…&share_text=…&share_url=…&share_files=N`. The new-chat page
// turns that into a prompt draft with the files attached.

export const SHARE_PARAMS = ['share_title', 'share_text', 'share_url', 'share_files'] as const;

/** Where the service worker parks shared files (keep in sync with share-target-sw.js). */
const SHARE_CACHE = 'chatty-share-target';
const ENTRY_PREFIX = '/__share-target/';

/** True when the URL is a share (with text, files or both). */
export function isShare(params: URLSearchParams): boolean {
	return SHARE_PARAMS.some((key) => params.has(key));
}

/**
 * The text draft for a share, or null when the URL isn't one. Apps fill the
 * fields inconsistently (Android often puts the link in `text`), so a field
 * already contained in another is left out.
 */
export function sharedDraft(params: URLSearchParams): string | null {
	if (!isShare(params)) return null;
	const title = params.get('share_title')?.trim() ?? '';
	const text = params.get('share_text')?.trim() ?? '';
	const url = params.get('share_url')?.trim() ?? '';
	const parts: string[] = [];
	if (title && !text.includes(title)) parts.push(title);
	if (text) parts.push(text);
	if (url && !text.includes(url)) parts.push(url);
	return parts.join('\n\n');
}

/**
 * Takes the files of the last share out of the service worker's cache, in the
 * order they were shared. Each share is picked up once: the cache is emptied.
 */
export async function takeSharedFiles(): Promise<File[]> {
	if (typeof caches === 'undefined' || !(await caches.has(SHARE_CACHE))) return [];
	const cache = await caches.open(SHARE_CACHE);
	const entries = (await cache.keys())
		.map((request) => ({
			request,
			index: Number(new URL(request.url).pathname.slice(ENTRY_PREFIX.length))
		}))
		.filter((entry) => Number.isInteger(entry.index))
		.sort((a, b) => a.index - b.index);
	const files: File[] = [];
	for (const { request, index } of entries) {
		const response = await cache.match(request);
		if (!response) continue;
		const blob = await response.blob();
		const name = decodeURIComponent(response.headers.get('x-file-name') ?? `shared-${index + 1}`);
		files.push(new File([blob], name, { type: blob.type }));
	}
	await caches.delete(SHARE_CACHE);
	return files;
}
