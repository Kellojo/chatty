// A coding task's changes as per-file unified diffs, parsed from the git diff
// text T3 Code returns (`review.getDiffPreview`). Shared by the server (which
// parses and caps it) and the diff dialog (which renders it).

export type CodingDiffLineKind = 'add' | 'del' | 'context' | 'hunk' | 'meta';

export interface CodingDiffLine {
	kind: CodingDiffLineKind;
	text: string;
}

export type CodingDiffFileStatus = 'added' | 'deleted' | 'renamed' | 'modified';

export interface CodingDiffFile {
	path: string;
	/** Set for renames. */
	previousPath: string | null;
	status: CodingDiffFileStatus;
	additions: number;
	deletions: number;
	binary: boolean;
	lines: CodingDiffLine[];
	/** Lines were left out (the file's diff is too long, or T3 cut the diff short). */
	truncated: boolean;
}

/** Which changes a source compares, as T3 names them. */
export type CodingDiffSourceKind = 'working-tree' | 'branch-range' | 'commit';

export interface CodingDiffSource {
	kind: CodingDiffSourceKind;
	title: string;
	baseRef: string | null;
	files: CodingDiffFile[];
	/** T3 or Chatty cut this diff short; some files or lines are missing. */
	truncated: boolean;
}

export interface CodingTaskDiff {
	sources: CodingDiffSource[];
}

/** Lines kept per file and in total, so a huge diff stays a reasonable response. */
export const MAX_DIFF_LINES_PER_FILE = 2_000;
export const MAX_DIFF_LINES_TOTAL = 20_000;

const unquote = (path: string) =>
	path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1).replace(/\\(.)/g, '$1') : path;

/** `a/foo` → `foo`; `/dev/null` → null. */
function stripPrefix(path: string): string | null {
	const p = unquote(path.trim().replace(/\t.*$/, ''));
	if (p === '/dev/null') return null;
	return p.replace(/^[ab]\//, '');
}

/** Both paths of a `diff --git a/x b/y` line (ambiguous with spaces; best effort). */
function gitHeaderPaths(line: string): { from: string; to: string } | null {
	const rest = line.slice('diff --git '.length);
	const quoted = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(rest);
	if (quoted) return { from: stripPrefix(`"${quoted[1]}"`)!, to: stripPrefix(`"${quoted[2]}"`)! };
	const mid = rest.indexOf(' b/');
	if (!rest.startsWith('a/') || mid === -1) return null;
	return { from: rest.slice(2, mid), to: rest.slice(mid + 3) };
}

function parseFile(chunk: string[], budget: { lines: number }): CodingDiffFile {
	const header = gitHeaderPaths(chunk[0] ?? '');
	let from: string | null = header?.from ?? null;
	let to: string | null = header?.to ?? null;
	let status: CodingDiffFileStatus = 'modified';
	let binary = false;
	let additions = 0;
	let deletions = 0;
	const lines: CodingDiffLine[] = [];
	let truncated = false;
	let inHunk = false;

	const push = (line: CodingDiffLine) => {
		if (lines.length >= MAX_DIFF_LINES_PER_FILE || budget.lines <= 0) {
			truncated = true;
			return;
		}
		lines.push(line);
		budget.lines--;
	};

	for (const line of chunk.slice(1)) {
		if (line.startsWith('@@')) {
			inHunk = true;
			push({ kind: 'hunk', text: line });
			continue;
		}
		if (inHunk) {
			const sign = line[0];
			if (sign === '+') {
				additions++;
				push({ kind: 'add', text: line.slice(1) });
			} else if (sign === '-') {
				deletions++;
				push({ kind: 'del', text: line.slice(1) });
			} else if (sign === ' ' || line === '') {
				push({ kind: 'context', text: line.slice(1) });
			} else if (sign === '\\') {
				push({ kind: 'meta', text: line });
			}
			continue;
		}
		if (line.startsWith('new file mode')) status = 'added';
		else if (line.startsWith('deleted file mode')) status = 'deleted';
		else if (line.startsWith('rename from ')) {
			from = unquote(line.slice('rename from '.length));
			status = 'renamed';
		} else if (line.startsWith('rename to ')) {
			to = unquote(line.slice('rename to '.length));
			status = 'renamed';
		} else if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true;
		else if (line.startsWith('--- ')) from = stripPrefix(line.slice(4));
		else if (line.startsWith('+++ ')) to = stripPrefix(line.slice(4));
	}

	if (from === null && to !== null) status = 'added';
	if (to === null && from !== null) status = 'deleted';
	const path = to ?? from ?? 'unknown';
	return {
		path,
		previousPath: status === 'renamed' && from !== path ? from : null,
		status,
		additions,
		deletions,
		binary,
		lines,
		truncated
	};
}

/**
 * Splits a `git diff` into its files. Counts stay exact; lines beyond
 * {@link MAX_DIFF_LINES_PER_FILE} per file or {@link MAX_DIFF_LINES_TOTAL}
 * overall are dropped and the file marked truncated.
 */
export function parseUnifiedDiff(diff: string): CodingDiffFile[] {
	const files: CodingDiffFile[] = [];
	const budget = { lines: MAX_DIFF_LINES_TOTAL };
	let chunk: string[] | null = null;
	const text = diff.endsWith('\n') ? diff.slice(0, -1) : diff;
	if (!text) return files;
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith('diff --git ')) {
			if (chunk) files.push(parseFile(chunk, budget));
			chunk = [line];
		} else if (chunk) {
			chunk.push(line);
		}
	}
	if (chunk) files.push(parseFile(chunk, budget));
	return files;
}

/** The source to open first: the branch's changes when there are any, else the working tree. */
export function defaultDiffSource(sources: readonly CodingDiffSource[]): CodingDiffSource | null {
	const nonEmpty = sources.filter((s) => s.files.length > 0);
	return (
		nonEmpty.find((s) => s.kind === 'branch-range') ??
		nonEmpty.find((s) => s.kind === 'working-tree') ??
		nonEmpty[0] ??
		sources[0] ??
		null
	);
}
