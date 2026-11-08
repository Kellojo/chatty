import { describe, expect, it } from 'vitest';
import { mayContainMath } from './katex-css.js';

describe('mayContainMath', () => {
	it('detects math delimiters', () => {
		expect(mayContainMath('$$x^2$$')).toBe(true);
		expect(mayContainMath('inline $x^2$ here')).toBe(true);
		expect(mayContainMath('a $x$ b')).toBe(true);
		expect(mayContainMath('\\(a+b\\)')).toBe(true);
		expect(mayContainMath('\\[a+b\\]')).toBe(true);
	});

	it('ignores plain prices and text', () => {
		expect(mayContainMath('It costs $5 and $10.')).toBe(false);
		expect(mayContainMath('no math here')).toBe(false);
		expect(mayContainMath('$ 5 $')).toBe(false);
	});
});
