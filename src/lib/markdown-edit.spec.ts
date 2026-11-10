import { describe, expect, it } from 'vitest';
import {
	continueList,
	cycleHeading,
	indent,
	linkFromPaste,
	toggleLinePrefix,
	toggleLink,
	toggleWrap,
	type TextEdit
} from './markdown-edit.js';

/** Writes a selection into text as `[` / `]` markers (`|` for a caret). */
function show(edit: TextEdit | null): string | null {
	if (!edit) return null;
	const { text, selStart, selEnd } = edit;
	if (selStart === selEnd) return text.slice(0, selStart) + '|' + text.slice(selStart);
	return text.slice(0, selStart) + '[' + text.slice(selStart, selEnd) + ']' + text.slice(selEnd);
}

/** Parses the same notation back into (text, selStart, selEnd). */
function at(marked: string): [string, number, number] {
	const caret = marked.indexOf('|');
	if (caret !== -1) return [marked.replace('|', ''), caret, caret];
	const s = marked.indexOf('[');
	const e = marked.indexOf(']') - 1;
	return [marked.replace('[', '').replace(']', ''), s, e];
}

describe('toggleWrap', () => {
	it('wraps a selection and keeps the inner text selected', () => {
		expect(show(toggleWrap(...at('a [word] b'), '**'))).toBe('a **[word]** b');
	});

	it('inserts an empty pair with the caret inside', () => {
		expect(show(toggleWrap(...at('a | b'), '**'))).toBe('a **|** b');
	});

	it('unwraps when the markers are just outside the selection', () => {
		expect(show(toggleWrap(...at('a **[word]** b'), '**'))).toBe('a [word] b');
	});

	it('unwraps when the selection includes the markers', () => {
		expect(show(toggleWrap(...at('a [**word**] b'), '**'))).toBe('a [word] b');
	});

	it('keeps surrounding whitespace outside the markers', () => {
		expect(show(toggleWrap(...at('a[ word ]b'), '**'))).toBe('a **[word]** b');
	});

	it('does not treat bold stars as italic', () => {
		expect(show(toggleWrap(...at('**[x]**'), '*'))).toBe('***[x]***');
		expect(show(toggleWrap(...at('***[x]***'), '*'))).toBe('**[x]**');
	});

	it('toggles inline code', () => {
		expect(show(toggleWrap(...at('`[x]`'), '`'))).toBe('[x]');
	});
});

describe('toggleLinePrefix', () => {
	it('adds a bullet to the current line', () => {
		expect(show(toggleLinePrefix(...at('item|'), '- '))).toBe('- item|');
	});

	it('removes a bullet that is already there', () => {
		expect(show(toggleLinePrefix(...at('- item|'), '- '))).toBe('item|');
	});

	it('numbers each selected line and skips blanks', () => {
		expect(show(toggleLinePrefix(...at('[a\n\nb\nc]'), '1. '))).toBe('[1. a\n\n2. b\n3. c]');
	});

	it('swaps one list kind for another', () => {
		expect(show(toggleLinePrefix(...at('- a|'), '- [ ] '))).toBe('- [ ] a|');
		expect(show(toggleLinePrefix(...at('- [x] a|'), '- '))).toBe('- a|');
	});

	it('keeps indentation', () => {
		expect(show(toggleLinePrefix(...at('  a|'), '- '))).toBe('  - a|');
	});

	it('toggles quotes on and off', () => {
		expect(show(toggleLinePrefix(...at('[a\nb]'), '> '))).toBe('[> a\n> b]');
		expect(show(toggleLinePrefix(...at('[> a\n> b]'), '> '))).toBe('[a\nb]');
	});

	it('ignores a line the selection only touches at its start', () => {
		expect(show(toggleLinePrefix(...at('[a\n]b'), '- '))).toBe('[- a\n]b');
	});
});

describe('cycleHeading', () => {
	it('cycles none → ## → ### → none', () => {
		const h2 = cycleHeading(...at('Ti|tle'));
		expect(show(h2)).toBe('## Ti|tle');
		const h3 = cycleHeading(h2.text, h2.selStart, h2.selEnd);
		expect(show(h3)).toBe('### Ti|tle');
		expect(show(cycleHeading(h3.text, h3.selStart, h3.selEnd))).toBe('Ti|tle');
	});

	it('only touches the current line', () => {
		expect(show(cycleHeading(...at('a\nb|\nc')))).toBe('a\n## b|\nc');
	});
});

describe('toggleLink', () => {
	it('wraps the selection and selects the url', () => {
		expect(show(toggleLink(...at('see [docs] now')))).toBe('see [docs]([url]) now');
		const r = toggleLink(...at('see [docs] now'));
		expect(r.text.slice(r.selStart, r.selEnd)).toBe('url');
	});

	it('uses a selected url as the target', () => {
		expect(show(toggleLink(...at('[https://x.dev]')))).toBe('[|](https://x.dev)');
	});

	it('unwraps an existing link', () => {
		expect(toggleLink('[a](b)', 0, 6)).toEqual({ text: 'a', selStart: 0, selEnd: 1 });
	});
});

describe('continueList', () => {
	it('continues bullets', () => {
		expect(show(continueList(...at('- a|')))).toBe('- a\n- |');
	});

	it('increments numbers', () => {
		expect(show(continueList(...at('  9) a|')))).toBe('  9) a\n  10) |');
	});

	it('continues checklists unchecked', () => {
		expect(show(continueList(...at('- [x] done|')))).toBe('- [x] done\n- [ ] |');
	});

	it('continues quotes', () => {
		expect(show(continueList(...at('> q|')))).toBe('> q\n> |');
	});

	it('splits a line at the caret', () => {
		expect(show(continueList(...at('- ab|cd')))).toBe('- ab\n- |cd');
	});

	it('removes the marker of an empty item', () => {
		expect(show(continueList(...at('- a\n- |')))).toBe('- a\n|');
	});

	it('leaves plain lines and selections alone', () => {
		expect(continueList(...at('plain|'))).toBeNull();
		expect(continueList(...at('- [ab]'))).toBeNull();
		expect(continueList(...at('-| a'))).toBeNull();
	});
});

describe('indent', () => {
	it('indents and outdents list lines', () => {
		expect(show(indent(...at('- a|')))).toBe('  - a|');
		expect(show(indent(...at('  - a|'), true))).toBe('- a|');
	});

	it('indents every list line in the selection', () => {
		expect(show(indent(...at('[- a\n- b]')))).toBe('[  - a\n  - b]');
	});

	it('returns null off a list line', () => {
		expect(indent(...at('plain|'))).toBeNull();
	});

	it('consumes Shift+Tab on an unindented item without changing it', () => {
		expect(show(indent(...at('- a|'), true))).toBe('- a|');
	});
});

describe('linkFromPaste', () => {
	it('links the selection to a pasted URL', () => {
		const r = linkFromPaste('see docs here', 4, 8, ' https://svelte.dev/docs ');
		expect(r).toEqual({
			text: 'see [docs](https://svelte.dev/docs) here',
			selStart: 35,
			selEnd: 35
		});
	});

	it('pastes normally without a selection, a URL, or across lines', () => {
		expect(linkFromPaste('abc', 1, 1, 'https://x.dev')).toBeNull();
		expect(linkFromPaste('abc', 0, 3, 'not a url')).toBeNull();
		expect(linkFromPaste(['a', 'b'].join('\n'), 0, 3, 'https://x.dev')).toBeNull();
		expect(linkFromPaste('https://a.dev', 0, 13, 'https://x.dev')).toBeNull();
	});
});
