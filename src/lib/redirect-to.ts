const BASE = 'http://same-site.invalid';

/**
 * A same-site path to return to after signing in (`?redirectTo=`), or '/' when
 * it is missing or could lead elsewhere. Parsed as a URL (the way browsers will
 * read the Location header) rather than pattern-matched, so tricks like
 * `/\evil.com` or a tab in `/<TAB>/evil.com` can't turn into another host.
 */
export function safeRedirectPath(value: string | null | undefined): string {
	if (!value || !value.startsWith('/')) return '/';
	// Browsers drop tabs and newlines and treat '\' as '/' while parsing: refuse them outright.
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f\\]/.test(value)) return '/';
	let url: URL;
	try {
		url = new URL(value, BASE);
	} catch {
		return '/';
	}
	if (url.origin !== BASE) return '/';
	return `${url.pathname}${url.search}${url.hash}`;
}
