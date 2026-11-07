import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from './frontmatter.js';

describe('parseFrontmatter', () => {
	it('parses YAML front-matter', () => {
		const parsed = parseFrontmatter('---\ntitle: Hello\ntags: [a, b]\n---\nBody');
		expect(parsed.data).toEqual({ title: 'Hello', tags: ['a', 'b'] });
		expect(parsed.content.trim()).toBe('Body');
	});

	it.each(['js', 'javascript', 'JS'])('refuses to evaluate ---%s front-matter', (lang) => {
		const g = globalThis as { __frontmatterPwned?: boolean };
		delete g.__frontmatterPwned;
		const input = `---${lang}\n{ title: (globalThis.__frontmatterPwned = true, 'x') }\n---\nBody`;
		expect(() => parseFrontmatter(input)).toThrow();
		expect(g.__frontmatterPwned).toBeUndefined();
	});
});
