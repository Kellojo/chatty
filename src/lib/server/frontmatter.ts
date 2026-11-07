import matter from 'gray-matter';

const disabled = {
	parse(): never {
		throw new Error('JavaScript front-matter is not supported');
	}
};

// gray-matter `eval`s `---js` / `---javascript` front-matter by default. Files
// parsed here come from git imports, uploads and agent-written memory, so the
// JS engine must never run. Passing options also bypasses gray-matter's global
// content cache, which would otherwise ignore these engine overrides.
const OPTIONS = { engines: { js: disabled, javascript: disabled } };

export function parseFrontmatter(input: string): matter.GrayMatterFile<string> {
	return matter(input, OPTIONS);
}
