/** Longest tool input/output body shown before it's cut (the full text stays one click away). */
export const TOOL_BODY_LIMIT = 4000;

/** Keeps the start of `text`; for structured results and inputs, where the beginning matters. */
export function truncateHead(text: string, limit = TOOL_BODY_LIMIT): string {
	return text.length > limit ? text.slice(0, limit) + '\n… truncated' : text;
}

/**
 * Keeps the end of `text`; for terminal output, where the summary or error
 * comes last. Starts at a line boundary when one is close, so the first
 * kept line isn't cut mid-way.
 */
export function truncateTail(text: string, limit = TOOL_BODY_LIMIT): string {
	if (text.length <= limit) return text;
	let start = text.length - limit;
	const newline = text.indexOf('\n', start);
	if (newline !== -1 && newline - start < 200 && newline < text.length - 1) start = newline + 1;
	return `… ${start.toLocaleString('en-US')} chars truncated\n${text.slice(start)}`;
}
