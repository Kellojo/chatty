/** Pulls a readable message out of an error that ends in a JSON body, like a provider's
 *  `…returned an error: {"code":500,"message":"Context size has been exceeded."}`.
 *  Text without such a body comes back unchanged. */
export function readableErrorText(error: string): string {
	const start = error.indexOf('{');
	if (start === -1 || !error.trimEnd().endsWith('}')) return error;
	let body: unknown;
	try {
		body = JSON.parse(error.slice(start));
	} catch {
		return error;
	}
	const message = jsonErrorMessage(body);
	if (!message) return error;
	const prefix = error.slice(0, start).replace(/[\s:]+$/, '');
	return prefix ? `${prefix}: ${message}` : message;
}

function jsonErrorMessage(body: unknown): string | null {
	if (!body || typeof body !== 'object') return null;
	const { message, error } = body as { message?: unknown; error?: unknown };
	if (typeof message === 'string' && message.trim()) return message.trim();
	if (typeof error === 'string' && error.trim()) return error.trim();
	return jsonErrorMessage(error);
}

/** The most specific clause of an error, for compact spots ("…returned an error: Context size
 *  has been exceeded." → "Context size has been exceeded."). Falls back to the whole text when
 *  the last clause is too short to mean anything on its own ("Request failed: 500"). */
export function errorSummary(error: string): string {
	const tail = error.split(': ').at(-1)?.trim() ?? '';
	return tail.length >= 12 && /\s/.test(tail) ? tail : error;
}
