/**
 * Sends text to the OS share sheet via the Web Share API (the reverse of the share target in
 * `share-target.ts`). Call `canShare()` after mount so SSR and hydration markup agree.
 */
import { toast } from 'svelte-sonner';

/** Above this, some share targets choke on the text, so it goes out as a `.md` file instead. */
export const MAX_SHARE_TEXT = 100_000;

export type ShareTextInput = { title?: string; text: string };

/** Whether this browser can open the share sheet. */
export function canShare(): boolean {
	return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/** A file name for shared text: the title made filesystem-safe, or a generic fallback. */
export function shareFileName(title?: string): string {
	const base = (title ?? '')
		.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80)
		.trim();
	return `${base || 'shared'}.md`;
}

/**
 * The share payload for `input`. Text longer than `MAX_SHARE_TEXT` becomes a markdown file when
 * `filesAllowed` says the browser accepts that file; otherwise the text is shared as is.
 */
export function buildSharePayload(
	{ title, text }: ShareTextInput,
	filesAllowed: (files: File[]) => boolean
): ShareData {
	const titled = title ? { title } : {};
	if (text.length > MAX_SHARE_TEXT) {
		const files = [new File([text], shareFileName(title), { type: 'text/markdown' })];
		if (filesAllowed(files)) return { ...titled, files };
	}
	return { ...titled, text };
}

/** Opens the share sheet. A dismissed sheet is silent; other failures show a toast. */
export async function shareText(input: ShareTextInput): Promise<void> {
	const payload = buildSharePayload(input, (files) => {
		try {
			return navigator.canShare?.({ files }) ?? false;
		} catch {
			return false;
		}
	});
	try {
		await navigator.share(payload);
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') return;
		toast.error('Failed to share');
	}
}
