/** A readable message for anything thrown, including plain objects from providers. */
export function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	if (error && typeof error === 'object') {
		const message = (error as { message?: unknown }).message;
		if (typeof message === 'string' && message) return message;
		try {
			return JSON.stringify(error);
		} catch {
			// Circular structures fall through to the generic text.
		}
	}
	return 'Unknown error';
}
