/**
 * Pure markdown text transforms for the memory editor. Each one takes the
 * full text plus the selection and returns the new text and selection, so
 * the component only has to apply the difference to the textarea.
 */

export type TextEdit = { text: string; selStart: number; selEnd: number };

export type ListPrefix = '- ' | '1. ' | '- [ ] ' | '> ';

const CHECK_RE = /^(\s*)([-*+]) \[[ xX]\] /;
const BULLET_RE = /^(\s*)([-*+]) /;
const NUMBER_RE = /^(\s*)(\d+)([.)]) /;
const QUOTE_RE = /^(\s*)> ?/;
const HEADING_RE = /^(#{1,6}) /;

/** Start/end offsets of the lines the selection touches. */
function lineRange(text: string, selStart: number, selEnd: number) {
	const start = text.lastIndexOf('\n', selStart - 1) + 1;
	// A selection ending right after a newline doesn't include the next line.
	const effectiveEnd = selEnd > selStart && text[selEnd - 1] === '\n' ? selEnd - 1 : selEnd;
	const nl = text.indexOf('\n', effectiveEnd);
	return { start, end: nl === -1 ? text.length : nl };
}

/** Maps a column through a prefix swap of `oldLen` → `newLen` chars. */
function mapCol(col: number, oldLen: number, newLen: number): number {
	return col >= oldLen ? col - oldLen + newLen : Math.min(col, newLen);
}

/**
 * Rewrites the prefix of every line in the selection. `rewrite` returns how
 * many leading chars to drop and what to put in their place (or null to keep
 * the line as is).
 */
function rewriteLines(
	text: string,
	selStart: number,
	selEnd: number,
	rewrite: (line: string, index: number) => { drop: number; insert: string } | null
): TextEdit {
	const { start, end } = lineRange(text, selStart, selEnd);
	const lines = text.slice(start, end).split('\n');
	let offset = start;
	let newOffset = start;
	let newStart = selStart;
	let newEnd = selEnd;
	const out = lines.map((line, i) => {
		const change = rewrite(line, i);
		const next = change ? change.insert + line.slice(change.drop) : line;
		const drop = change?.drop ?? 0;
		const ins = change?.insert.length ?? 0;
		const lineEnd = offset + line.length;
		if (selStart >= offset && selStart <= lineEnd) {
			// A range selected from a line start keeps covering the whole prefix.
			const col = selStart - offset;
			newStart = newOffset + (col === 0 && selEnd > selStart ? 0 : mapCol(col, drop, ins));
		}
		if (selEnd >= offset && selEnd <= lineEnd) {
			newEnd = newOffset + mapCol(selEnd - offset, drop, ins);
		}
		offset = lineEnd + 1;
		newOffset += next.length + 1;
		return next;
	});
	const joined = out.join('\n');
	const result = text.slice(0, start) + joined + text.slice(end);
	// Selection end past the rewritten block (trailing newline case).
	if (selEnd > end) newEnd = selEnd + (joined.length - (end - start));
	return { text: result, selStart: newStart, selEnd: Math.max(newStart, newEnd) };
}

/** Length of the run of `ch` ending at `pos` (exclusive) / starting at `pos`. */
function runBefore(text: string, pos: number, ch: string): number {
	let n = 0;
	while (pos - n - 1 >= 0 && text[pos - n - 1] === ch) n++;
	return n;
}
function runAfter(text: string, pos: number, ch: string): number {
	let n = 0;
	while (pos + n < text.length && text[pos + n] === ch) n++;
	return n;
}

/**
 * Whether a run of `run` repeated marker chars carries `marker`. Bold (`**`)
 * needs two or more; a single-char marker needs an odd run so `*` doesn't
 * match the stars of `**bold**`.
 */
function runHasMarker(run: number, marker: string): boolean {
	return marker.length === 1 ? run % 2 === 1 : run >= marker.length;
}

/**
 * Wraps the selection in `marker` (e.g. `**`), or unwraps it when it is
 * already wrapped (markers just outside or just inside the selection).
 */
export function toggleWrap(
	text: string,
	selStart: number,
	selEnd: number,
	marker: string
): TextEdit {
	const m = marker.length;
	const repeated = [...marker].every((c) => c === marker[0]);
	const ch = marker[0];

	// Leave surrounding whitespace (e.g. from a double-click) outside the markers.
	let s = selStart;
	let e = selEnd;
	while (s < e && /\s/.test(text[s])) s++;
	while (e > s && /\s/.test(text[e - 1])) e--;
	if (s === e) {
		s = selStart;
		e = selEnd;
	}

	const outside = repeated
		? runHasMarker(Math.min(runBefore(text, s, ch), runAfter(text, e, ch)), marker)
		: text.slice(s - m, s) === marker && text.slice(e, e + m) === marker;
	if (outside) {
		return {
			text: text.slice(0, s - m) + text.slice(s, e) + text.slice(e + m),
			selStart: s - m,
			selEnd: e - m
		};
	}

	const inner = text.slice(s, e);
	const inside =
		inner.length >= 2 * m &&
		(repeated
			? runHasMarker(
					Math.min(runAfter(inner, 0, ch), runBefore(inner, inner.length, ch)),
					marker
				) && inner.length > 2 * m
			: inner.startsWith(marker) && inner.endsWith(marker));
	if (inside) {
		return {
			text: text.slice(0, s) + inner.slice(m, inner.length - m) + text.slice(e),
			selStart: s,
			selEnd: e - 2 * m
		};
	}

	return {
		text: text.slice(0, s) + marker + inner + marker + text.slice(e),
		selStart: s + m,
		selEnd: e + m
	};
}

type ParsedLine = { indent: string; marker: string; kind: 'check' | 'bullet' | 'number' | null };

function parseListLine(line: string): ParsedLine {
	let m = CHECK_RE.exec(line);
	if (m) return { indent: m[1], marker: m[0].slice(m[1].length), kind: 'check' };
	m = NUMBER_RE.exec(line);
	if (m) return { indent: m[1], marker: m[0].slice(m[1].length), kind: 'number' };
	m = BULLET_RE.exec(line);
	if (m) return { indent: m[1], marker: m[0].slice(m[1].length), kind: 'bullet' };
	return { indent: /^\s*/.exec(line)![0], marker: '', kind: null };
}

const PREFIX_KIND = { '- ': 'bullet', '1. ': 'number', '- [ ] ': 'check' } as const;

/**
 * Toggles a line prefix (bullet, numbered, checklist or quote) on every line
 * of the selection. Removes it when all non-empty lines already have it;
 * otherwise sets it, replacing any other list marker. Numbers count up.
 */
export function toggleLinePrefix(
	text: string,
	selStart: number,
	selEnd: number,
	prefix: ListPrefix
): TextEdit {
	const { start, end } = lineRange(text, selStart, selEnd);
	const lines = text.slice(start, end).split('\n');
	const single = lines.length === 1;
	const counts = (line: string) => single || line.trim() !== '';

	if (prefix === '> ') {
		const all = lines.filter(counts).every((l) => QUOTE_RE.test(l));
		return rewriteLines(text, selStart, selEnd, (line) => {
			if (!counts(line)) return null;
			if (all) {
				const q = QUOTE_RE.exec(line)!;
				return { drop: q[0].length, insert: q[1] };
			}
			return { drop: 0, insert: '> ' };
		});
	}

	const kind = PREFIX_KIND[prefix];
	const all = lines.filter(counts).every((l) => parseListLine(l).kind === kind);
	let n = 0;
	return rewriteLines(text, selStart, selEnd, (line) => {
		if (!counts(line)) return null;
		const p = parseListLine(line);
		const drop = p.indent.length + p.marker.length;
		if (all) return { drop, insert: p.indent };
		n++;
		return { drop, insert: p.indent + (kind === 'number' ? `${n}. ` : prefix) };
	});
}

/** Cycles the heading of the selected lines: none → ## → ### → none. */
export function cycleHeading(text: string, selStart: number, selEnd: number): TextEdit {
	const { start, end } = lineRange(text, selStart, selEnd);
	const lines = text.slice(start, end).split('\n');
	const single = lines.length === 1;
	const first = lines.find((l) => l.trim() !== '') ?? lines[0];
	const level = HEADING_RE.exec(first)?.[1].length ?? 0;
	const next = level === 0 ? '## ' : level < 3 ? '### ' : '';
	return rewriteLines(text, selStart, selEnd, (line) => {
		if (!single && line.trim() === '') return null;
		const h = HEADING_RE.exec(line);
		return { drop: h ? h[0].length : 0, insert: next };
	});
}

/**
 * Wraps the selection as a link `[sel](url)` and selects `url`. A selected
 * URL becomes the target instead, with the caret in the empty label. An
 * already-linked selection `[label](url)` is unwrapped to its label.
 */
export function toggleLink(text: string, selStart: number, selEnd: number): TextEdit {
	const sel = text.slice(selStart, selEnd);
	const linked = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(sel);
	if (linked) {
		const label = linked[1];
		return {
			text: text.slice(0, selStart) + label + text.slice(selEnd),
			selStart,
			selEnd: selStart + label.length
		};
	}
	if (/^https?:\/\/\S+$/.test(sel)) {
		return {
			text: text.slice(0, selStart) + `[](${sel})` + text.slice(selEnd),
			selStart: selStart + 1,
			selEnd: selStart + 1
		};
	}
	const label = sel || 'link';
	const urlStart = selStart + label.length + 3;
	return {
		text: text.slice(0, selStart) + `[${label}](url)` + text.slice(selEnd),
		selStart: urlStart,
		selEnd: urlStart + 3
	};
}

/**
 * Handles Enter on a list or quote line: continues the marker on a new line
 * (next number, unchecked box), or clears the marker of an empty item.
 * Returns null when Enter should behave normally.
 */
/**
 * Pasting a URL over selected text links the text, like GitHub and Notion do.
 * Null when the paste isn't a lone URL or nothing is selected (paste normally).
 */
export function linkFromPaste(
	text: string,
	selStart: number,
	selEnd: number,
	pasted: string
): TextEdit | null {
	const url = pasted.trim();
	if (selStart === selEnd || !/^https?:\/\/\S+$/i.test(url)) return null;
	const selected = text.slice(selStart, selEnd);
	// Don't wrap something that's already a URL or spans lines.
	if (/^https?:\/\//i.test(selected.trim()) || selected.includes('\n')) return null;
	const link = `[${selected}](${url})`;
	return {
		text: text.slice(0, selStart) + link + text.slice(selEnd),
		selStart: selStart + link.length,
		selEnd: selStart + link.length
	};
}

export function continueList(text: string, selStart: number, selEnd: number): TextEdit | null {
	if (selStart !== selEnd) return null;
	const start = text.lastIndexOf('\n', selStart - 1) + 1;
	const nl = text.indexOf('\n', selStart);
	const end = nl === -1 ? text.length : nl;
	const line = text.slice(start, end);

	let prefix: string;
	let next: string;
	const p = parseListLine(line);
	if (p.kind) {
		prefix = p.indent + p.marker;
		if (p.kind === 'check') next = `${p.marker[0]} [ ] `;
		else if (p.kind === 'number') {
			const m = NUMBER_RE.exec(line)!;
			next = `${Number(m[2]) + 1}${m[3]} `;
		} else next = p.marker;
		next = p.indent + next;
	} else {
		const q = QUOTE_RE.exec(line);
		if (!q) return null;
		prefix = q[0];
		next = q[1] + '> ';
	}

	const col = selStart - start;
	if (col < prefix.length) return null;

	if (line.slice(prefix.length).trim() === '') {
		return { text: text.slice(0, start) + text.slice(end), selStart: start, selEnd: start };
	}

	const insert = '\n' + next;
	return {
		text: text.slice(0, selStart) + insert + text.slice(selEnd),
		selStart: selStart + insert.length,
		selEnd: selStart + insert.length
	};
}

/**
 * Indents (or outdents) the selected list lines by two spaces. Returns null
 * when the caret isn't on a list line, so Tab keeps moving focus.
 */
export function indent(
	text: string,
	selStart: number,
	selEnd: number,
	outdent = false
): TextEdit | null {
	const start = text.lastIndexOf('\n', selStart - 1) + 1;
	const nl = text.indexOf('\n', start);
	if (!parseListLine(text.slice(start, nl === -1 ? text.length : nl)).kind) return null;
	return rewriteLines(text, selStart, selEnd, (line) => {
		if (!parseListLine(line).kind) return null;
		if (!outdent) return { drop: 0, insert: '  ' };
		const lead = /^ {0,2}/.exec(line)![0].length || (line.startsWith('\t') ? 1 : 0);
		return lead ? { drop: lead, insert: '' } : null;
	});
}
