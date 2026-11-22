// Coding agents cite files as markdown links to a path on their own machine,
// often with a line: `[http.ts:42](/abs/path/http.ts:42)`, `C:\repo\a.ts:7`,
// `src/a.ts#L3-L9`. Browsers can't open those, so in a coding chat Chatty
// rewrites them to `?file=…` on the chat itself, and clicking one opens the
// file (read from the T3 machine) in a viewer instead of navigating.

export interface CodingFileRef {
	/** The path as the agent wrote it (line suffix removed). */
	path: string;
	/** 1-based line to show, if the link names one. */
	line: number | null;
	/** Last line of a range (`:3-9`, `#L3-L9`), if any. */
	endLine: number | null;
	/** Opened from a checkpoint card, which says this run changed the file. */
	fromCheckpoint?: boolean;
}

/** A file read from the coding machine, as `/api/coding/tasks/[id]/file` returns it. */
export interface CodingFileContents {
	/** Absolute path on the coding machine. */
	absolutePath: string;
	/** Path inside the task's workspace (`/`-separated, as diffs name it), or null outside it. */
	workspacePath: string | null;
	/** False when the file doesn't exist (any more). */
	exists: boolean;
	contents: string;
	byteLength: number;
	/** T3 sends at most 1 MiB of a file. */
	truncated: boolean;
}

/** Context a coding chat provides so file links in its messages open its file viewer. */
export const CODING_FILES_CONTEXT = 'codingFiles';

export interface CodingFilesViewer {
	/** Whether the chat is a coding task (it can become one after it opened). */
	readonly enabled: boolean;
	open(ref: CodingFileRef): void;
	/** Opens the task's whole diff (the topbar's Changes dialog), when the chat offers it. */
	openChanges?(): void;
}

/** Longest path accepted; T3 itself caps relative paths at 512 characters. */
const MAX_PATH_LENGTH = 1024;

/** `:42`, `:42:7`, `:42-50`, `#L42`, `#L42C7`, `#L42-L50`. */
const LINE_SUFFIX = /(?::(\d+)(?::\d+)?(?:-(\d+))?|#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?)$/;

const WINDOWS_ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\)/i;
/** A URL scheme (`https:`, `mailto:`); one letter is a drive, not a scheme. */
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;
/** The last segment has an extension (`a.ts`) or is a dotfile (`.env`). */
const HAS_EXTENSION = /(?:^|[\\/])\.?[^\\/.]+\.[^\\/.]+$|(?:^|[\\/])\.[^\\/.]+$/;
/** Common top-level domains, so `example.com` isn't read as a file. */
const DOMAIN_LIKE =
	/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|ai|co|me|gg|xyz)(?:[/?#:]|$)/i;

function decode(path: string): string {
	if (!path.includes('%')) return path;
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

/** Whether `path` (no line suffix) reads as a file path rather than a web or app URL. */
function looksLikeFilePath(path: string, hasLine: boolean): boolean {
	if (!path || path.length > MAX_PATH_LENGTH || path.includes('\0')) return false;
	if (/[\r\n]/.test(path)) return false;
	if (WINDOWS_ABSOLUTE.test(path)) return true;
	if (path.startsWith('~/') || path.startsWith('~\\')) return true;
	if (SCHEME.test(path) || path.startsWith('//') || /^[?#]/.test(path)) return false;
	// Chatty's own pages never carry an extension; files usually do.
	if (path.startsWith('/')) return hasLine || HAS_EXTENSION.test(path);
	if (DOMAIN_LIKE.test(path)) return false;
	return hasLine || HAS_EXTENSION.test(path);
}

/**
 * The file a link points to, or null when `href` is a web or app URL.
 * Accepts absolute paths (POSIX, Windows, UNC, `~`), `file://` URLs and
 * paths relative to the task's workspace.
 */
export function parseCodingFileRef(href: string): CodingFileRef | null {
	let path = href.trim();
	if (/^file:\/\//i.test(path)) {
		path = path.replace(/^file:\/\/(?:localhost)?/i, '');
		if (!path.startsWith('/')) path = `//${path}`; // file://server/share → UNC
	}
	path = decode(path);
	// `/C:/repo/a.ts` (a file URL's path) → `C:/repo/a.ts`.
	if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);

	let line: number | null = null;
	let endLine: number | null = null;
	const suffix = LINE_SUFFIX.exec(path);
	if (suffix) {
		const start = Number(suffix[1] ?? suffix[3]);
		const end = Number(suffix[2] ?? suffix[4] ?? NaN);
		if (start > 0) {
			line = start;
			endLine = end >= start ? end : null;
		}
		path = path.slice(0, suffix.index);
	} else if (path.includes('#')) {
		return null;
	}
	if (!looksLikeFilePath(path, line !== null)) return null;
	return { path, line, endLine };
}

/**
 * The file an inline code span names (`` `src/a.ts:42` ``), held to a stricter
 * standard than a link: code spans also hold `user.name`, `$lib/x.ts` and
 * `node:fs`, so it needs a folder or a line, and a letter-led extension.
 */
export function parseInlineCodeFileRef(text: string): CodingFileRef | null {
	const code = text.trim();
	if (!code || /\s/.test(code) || /^[$@]/.test(code)) return null;
	const ref = parseCodingFileRef(code);
	if (!ref) return null;
	const hasFolder = /[\\/]/.test(ref.path.replace(/^\.[\\/]/, ''));
	if (!hasFolder && ref.line === null) return null;
	const name = ref.path.split(/[\\/]/).pop() ?? '';
	// Well-known files without an extension, when a line says it's a file.
	if (ref.line !== null && /^(?:dockerfile|makefile)$/i.test(name)) return ref;
	return /^\.?[^.]+(?:\.[^.]+)*\.[a-z][a-z0-9]*$/i.test(name) || /^\.[a-z]/i.test(name)
		? ref
		: null;
}

/**
 * A file link's click: opens the viewer in place. Clicks with a modifier key
 * or another button keep the browser's handling (a new tab opens the chat on the file).
 */
export function followCodingFileLink(
	event: MouseEvent,
	viewer: CodingFilesViewer | undefined,
	ref: CodingFileRef | null
): void {
	if (!ref || !viewer || event.button !== 0) return;
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	event.preventDefault();
	viewer.open(ref);
}

/** Set by a link while it renders its text, so code spans inside it don't link again. */
export const INSIDE_LINK_CONTEXT = 'insideMarkdownLink';

/** The chat URL that opens `ref` in the conversation's file viewer. */
export function codingFileHref(conversationId: string, ref: CodingFileRef): string {
	const params = new URLSearchParams({ file: ref.path });
	if (ref.line) params.set('line', String(ref.line));
	if (ref.line && ref.endLine) params.set('end', String(ref.endLine));
	return `/chat/${encodeURIComponent(conversationId)}?${params}`;
}

/** Reads the `?file=` parameters made by {@link codingFileHref}. */
export function readCodingFileParams(params: URLSearchParams): CodingFileRef | null {
	const path = params.get('file');
	if (!path || path.length > MAX_PATH_LENGTH) return null;
	const num = (key: string) => {
		const n = Number(params.get(key));
		return Number.isInteger(n) && n > 0 ? n : null;
	};
	const line = num('line');
	const end = line ? num('end') : null;
	return { path, line, endLine: end && line && end >= line ? end : null };
}

/** The viewer's state for a link `href`, if it's one made by {@link codingFileHref}. */
export function parseCodingFileHref(href: string, conversationId: string): CodingFileRef | null {
	const prefix = `/chat/${encodeURIComponent(conversationId)}?`;
	if (!href.startsWith(prefix)) return null;
	return readCodingFileParams(new URLSearchParams(href.slice(prefix.length)));
}

/** `C:\repo\src\a.ts` → `{ name: 'a.ts', dir: 'C:\repo\src' }`. */
export function splitFilePath(path: string): { name: string; dir: string } {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut === -1
		? { name: path, dir: '' }
		: { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

/** The shiki language for a file name, by extension; null for plain text. */
export function fileLanguage(name: string): string | null {
	const lower = name.toLowerCase();
	if (lower === 'dockerfile') return 'docker';
	if (lower === 'makefile') return 'make';
	const ext = /\.([a-z0-9]+)$/.exec(lower)?.[1];
	if (!ext) return null;
	return LANGUAGES[ext] ?? null;
}

const LANGUAGES: Record<string, string> = {
	ts: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	tsx: 'tsx',
	js: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	jsx: 'jsx',
	svelte: 'svelte',
	vue: 'vue',
	json: 'json',
	jsonc: 'jsonc',
	md: 'markdown',
	mdx: 'mdx',
	css: 'css',
	scss: 'scss',
	less: 'less',
	html: 'html',
	xml: 'xml',
	svg: 'xml',
	yml: 'yaml',
	yaml: 'yaml',
	toml: 'toml',
	ini: 'ini',
	sql: 'sql',
	sh: 'bash',
	bash: 'bash',
	zsh: 'bash',
	ps1: 'powershell',
	py: 'python',
	rb: 'ruby',
	rs: 'rust',
	go: 'go',
	java: 'java',
	kt: 'kotlin',
	swift: 'swift',
	c: 'c',
	h: 'c',
	cpp: 'cpp',
	hpp: 'cpp',
	cc: 'cpp',
	cs: 'csharp',
	php: 'php',
	lua: 'lua',
	dart: 'dart',
	graphql: 'graphql',
	prisma: 'prisma'
};
