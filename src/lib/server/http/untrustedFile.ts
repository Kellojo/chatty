// Headers for serving user- or agent-supplied files from the app's own origin.
// `sandbox` (without allow-scripts / allow-same-origin) gives an HTML or SVG
// document an opaque origin and disables scripts, so it can't act as the
// logged-in user. `nosniff` stops browsers from reinterpreting e.g. a
// text/plain file as HTML.
const SANDBOX_CSP =
	"sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; " +
	"style-src 'unsafe-inline'; font-src data:";

export function untrustedFileHeaders(mime: string): Record<string, string> {
	const headers: Record<string, string> = { 'x-content-type-options': 'nosniff' };
	// Browser PDF viewers refuse to render sandboxed documents; they run PDFs in
	// their own isolated context anyway.
	if (mime.split(';')[0].trim().toLowerCase() !== 'application/pdf') {
		headers['content-security-policy'] = SANDBOX_CSP;
	}
	return headers;
}

/** RFC 6266 Content-Disposition with a header-safe filename. */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
	const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
	return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
