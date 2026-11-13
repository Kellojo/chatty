import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';

/** A single byte range, inclusive at both ends. */
interface ByteRange {
	start: number;
	end: number;
}

/**
 * Parses a `Range` header against a file of `size` bytes. Returns null to
 * serve the whole file (no header, syntax we don't handle, or several ranges:
 * all allowed by RFC 9110 §14.2) and 'unsatisfiable' for a well-formed range
 * that lies outside the file.
 */
export function parseRange(
	header: string | null,
	size: number
): ByteRange | 'unsatisfiable' | null {
	const m = header?.trim().match(/^bytes=(\d*)-(\d*)$/i);
	if (!m || (m[1] === '' && m[2] === '')) return null;
	if (m[1] === '') {
		const suffix = Number(m[2]);
		if (suffix === 0 || size === 0) return 'unsatisfiable';
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(m[1]);
	const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
	if (m[2] !== '' && Number(m[2]) < start) return null;
	if (start >= size) return 'unsatisfiable';
	return { start, end };
}

function etagMatches(header: string, etag: string): boolean {
	const bare = etag.replace(/^W\//, '');
	return header
		.split(',')
		.map((t) => t.trim())
		.some((t) => t === '*' || t.replace(/^W\//, '') === bare);
}

/**
 * Streams a file as a Response, with `ETag` / `Last-Modified` validators
 * (answering conditional requests with 304), `Accept-Ranges` and
 * single-range 206 / 416 handling, so media can seek and nothing is buffered
 * whole in memory. `headers` (content type, caching, …) are sent on every
 * response. Rejects when the file can't be opened.
 */
export async function fileResponse(
	abs: string,
	request: Request,
	headers: Record<string, string>
): Promise<Response> {
	const handle = await fsp.open(abs, 'r');
	let streaming = false;
	try {
		const stat = await handle.stat();
		const size = stat.size;
		const etag = `"${Math.floor(stat.mtimeMs).toString(16)}-${size.toString(16)}"`;
		const lastModified = new Date(stat.mtimeMs).toUTCString();
		const base = {
			...headers,
			etag,
			'last-modified': lastModified,
			'accept-ranges': 'bytes'
		};

		const ifNoneMatch = request.headers.get('if-none-match');
		const ifModifiedSince = request.headers.get('if-modified-since');
		const notModified =
			ifNoneMatch !== null
				? etagMatches(ifNoneMatch, etag)
				: ifModifiedSince !== null &&
					Math.floor(stat.mtimeMs / 1000) * 1000 <= Date.parse(ifModifiedSince);
		if (notModified) return new Response(null, { status: 304, headers: base });

		// If-Range: only honour the range when the client's copy is still current.
		const ifRange = request.headers.get('if-range');
		const rangeAllowed = ifRange === null || ifRange === etag || ifRange === lastModified;
		const range = rangeAllowed ? parseRange(request.headers.get('range'), size) : null;
		if (range === 'unsatisfiable') {
			return new Response(null, {
				status: 416,
				headers: { ...base, 'content-range': `bytes */${size}` }
			});
		}
		const { start, end } = range ?? { start: 0, end: size - 1 };
		const bodyHeaders = {
			...base,
			'content-length': String(end - start + 1),
			...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
		};
		const status = range ? 206 : 200;
		// HEAD, or nothing to send: don't open a stream nobody would read.
		if (request.method === 'HEAD' || size === 0) {
			return new Response(null, { status, headers: bodyHeaders });
		}

		const stream = handle.createReadStream({ start, end, autoClose: true });
		streaming = true;
		const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
		return new Response(body, { status, headers: bodyHeaders });
	} finally {
		// The read stream owns (and closes) the handle once it exists.
		if (!streaming) await handle.close();
	}
}
