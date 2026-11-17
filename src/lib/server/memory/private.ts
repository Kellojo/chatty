import { parseFrontmatter } from '../frontmatter.js';

/**
 * The private flag of a concept file: frontmatter `private: true`. A file whose
 * frontmatter can't be parsed (`data` null) still counts as private when it has
 * the line, so a broken file fails closed instead of being served as public text.
 */
export function conceptIsPrivate(data: Record<string, unknown> | null, raw: string): boolean {
	if (data) return data.private === true;
	return /^private:\s*true\s*$/m.test(raw);
}

/** The private flag of a concept file's raw text. */
export function rawConceptIsPrivate(raw: string): boolean {
	let data: Record<string, unknown> | null = null;
	try {
		data = parseFrontmatter(raw).data as Record<string, unknown>;
	} catch {
		// unparseable: fall back to the line check
	}
	return conceptIsPrivate(data, raw);
}
