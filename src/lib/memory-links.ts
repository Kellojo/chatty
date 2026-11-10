// Links between memories: relative `.md` paths inside a memory's markdown.

/**
 * The markdown renderer blocks bare relative paths (`science/x.md`) as unsafe URLs.
 * Links between memories are written that way, so mark them explicitly relative.
 */
export function markMemoryLinksRelative(markdown: string): string {
	return markdown.replace(
		/\]\((?![a-z][a-z0-9+.-]*:|\/|\.{1,2}\/|#)([^)\s]+\.md(?:#[^)\s]*)?)(\s+"[^"]*")?\)/gi,
		'](./$1$2)'
	);
}

/** Resolves a link in a memory the way the server does: relative to the file, else bundle-relative. */
export function resolveMemoryLink(from: string, href: string, known: Set<string>): string | null {
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return null;
	let target = href.split('#')[0].split('?')[0];
	try {
		target = decodeURIComponent(target);
	} catch {
		return null;
	}
	if (!target.endsWith('.md')) return null;
	const normalize = (p: string) => {
		const out: string[] = [];
		for (const part of p.split('/')) {
			if (!part || part === '.') continue;
			if (part === '..') out.pop();
			else out.push(part);
		}
		return out.join('/');
	};
	const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
	const candidates = [normalize(`${dir}/${target}`), normalize(target)];
	return candidates.find((c) => c !== from && known.has(c)) ?? null;
}
