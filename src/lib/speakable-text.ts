/**
 * How much of a reply is read aloud. Playback is chunked well under the speech
 * APIs' per-request limit, so this only bounds the number of requests.
 */
export const MAX_SPEAKABLE_LENGTH = 20_000;

/**
 * Turns a markdown reply into plain prose for reading aloud: code blocks, images
 * and markup are dropped, links keep their text. Cut at a sentence end so it
 * fits within `max` characters.
 */
export function speakableText(markdown: string, max = MAX_SPEAKABLE_LENGTH): string {
	const text = markdown
		.replace(/```[\s\S]*?(```|$)/g, '\n')
		.replace(/<[^>\n]+>/g, '')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/`([^`]+)`/g, '$1')
		// Table separator rows go entirely; other rows read as comma-separated cells.
		.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*(\n|$)/gm, '')
		.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) =>
			row
				.split('|')
				.map((c) => c.trim())
				.join(', ')
		)
		.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
		.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
		.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
		.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
		.replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
		.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
		.replace(/(^|\W)_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
		.replace(/[ \t]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	if (text.length <= max) return text;
	const head = text.slice(0, max);
	const end = Math.max(
		head.lastIndexOf('. '),
		head.lastIndexOf('! '),
		head.lastIndexOf('? '),
		head.lastIndexOf('\n')
	);
	return (end > max / 2 ? head.slice(0, end + 1) : head).trim();
}

/**
 * Splits text into sentence-sized chunks of at most `max` characters. Browser
 * voices stop partway through long utterances, so they're queued in pieces.
 */
export function speechChunks(text: string, max = 200, firstMax = max): string[] {
	// Each sentence, and whether a line break follows it.
	const sentences = [...text.matchAll(/[^.!?\n]+(?:[.!?]+|\n+|$)/g)].map((m) => ({
		raw: m[0],
		breakAfter: /^[ \t]*\n/.test(text.slice(m.index + m[0].length)) || m[0].endsWith('\n')
	}));
	const chunks: string[] = [];
	let current = '';
	/** What joins the next sentence to `current`: a line break where the text had one. */
	let sep = ' ';
	const limit = () => (chunks.length === 0 ? firstMax : max);
	const flush = () => {
		if (current) chunks.push(current);
		current = '';
	};
	for (const { raw, breakAfter } of sentences) {
		const sentence = raw.trim();
		if (!sentence) continue;
		if (current && current.length + 1 + sentence.length > limit()) flush();
		if (sentence.length > limit()) {
			// One very long sentence: break at word boundaries.
			for (const word of sentence.split(/\s+/)) {
				if (current && current.length + 1 + word.length > limit()) flush();
				current = current ? `${current} ${word}` : word;
			}
		} else {
			current = current ? `${current}${sep}${sentence}` : sentence;
		}
		sep = breakAfter ? '\n' : ' ';
	}
	flush();
	return chunks;
}

/**
 * Chunks for server speech, fetched one ahead of playback: a short first chunk
 * so audio starts quickly, then larger ones to keep requests few.
 */
export function serverChunks(text: string, first = 200, later = 1000): string[] {
	return speechChunks(text, later, first);
}
