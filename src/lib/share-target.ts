// Web Share Target: other apps share into Chatty by opening
// `/?share_title=…&share_text=…&share_url=…` (manifest `share_target` in
// vite.config.ts). The new-chat page turns that into a prompt draft.

export const SHARE_PARAMS = ['share_title', 'share_text', 'share_url'] as const;

/**
 * The draft for a share, or null when the URL isn't one. Apps fill the fields
 * inconsistently (Android often puts the link in `text`), so a field already
 * contained in another is left out.
 */
export function sharedDraft(params: URLSearchParams): string | null {
	if (!SHARE_PARAMS.some((key) => params.has(key))) return null;
	const title = params.get('share_title')?.trim() ?? '';
	const text = params.get('share_text')?.trim() ?? '';
	const url = params.get('share_url')?.trim() ?? '';
	const parts: string[] = [];
	if (title && !text.includes(title)) parts.push(title);
	if (text) parts.push(text);
	if (url && !text.includes(url)) parts.push(url);
	return parts.join('\n\n');
}
