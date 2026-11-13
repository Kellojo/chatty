import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import git, { type HttpClient } from 'isomorphic-git';
import matter from 'gray-matter';
import { parseFrontmatter } from '../frontmatter.js';
import { safeFetch } from '../net/safeFetch.js';
import { isValidSkillName, skillsRoot, findSkillFile, type SkillScope } from './paths.js';
import { parseSkillFrontmatter } from './scanner.js';

export interface GitImportInput {
	gitUrl: string;
	branch?: string;
	path?: string;
	scope?: SkillScope;
	userId: string;
}

export interface ImportedSkill {
	name: string;
	action: 'created' | 'updated';
}

export interface GitImportResult {
	imported: ImportedSkill[];
	skipped: Array<{ name: string; reason: string }>;
}

const LOCAL_SUFFIX = '.local';

export interface ParsedGitUrl {
	gitUrl: string;
	branch?: string;
	path?: string;
}

// Recognizes common web UI URL shapes and extracts clone URL, branch and
// subpath, e.g.:
//   https://github.com/user/repo/tree/main/skills
//   https://github.com/user/repo/blob/main/skills/skill-a
//   https://gitlab.com/user/repo/-/tree/main/skills
//   https://bitbucket.org/user/repo/src/main/skills
// Plain repo URLs (optionally ending in .git) pass through unchanged.
export function parseGitUrl(input: string): ParsedGitUrl {
	const trimmed = input.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { gitUrl: trimmed };
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return { gitUrl: trimmed };
	const segments = url.pathname.split('/').filter(Boolean);
	if (segments.length < 2) return { gitUrl: trimmed };

	// Find the web-UI marker segment after "<owner>/<repo>" (GitLab inserts "/-"): tree, blob or src.
	const markerIndex = segments.findIndex(
		(seg, i) => i >= 2 && (seg === 'tree' || seg === 'blob' || seg === 'src')
	);
	if (markerIndex === -1) return { gitUrl: trimmed };

	const repoSegments = segments.slice(0, markerIndex).filter((seg) => seg !== '-');
	const repoPath = repoSegments.join('/');
	const clonePath = repoPath.endsWith('.git') ? repoPath : `${repoPath}.git`;
	const gitUrl = `${url.origin}/${clonePath}`;

	const rest = segments.slice(markerIndex + 1);
	if (rest.length === 0) return { gitUrl };
	const branch = rest[0];
	const subPath = rest.slice(1).join('/');
	// 'blob' points at a file; use its parent directory
	const dirPath =
		segments[markerIndex] === 'blob' ? subPath.split('/').slice(0, -1).join('/') : subPath;
	return {
		gitUrl,
		branch: branch || undefined,
		path: dirPath || undefined
	};
}

// Limits for one import, so a huge repo can't fill the disk or memory.
export const MAX_IMPORT_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_CHECKOUT_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_FILES = 2000;

export class ImportLimitError extends Error {
	constructor(what: string) {
		super(`Repository too large: exceeds ${what}`);
		this.name = 'ImportLimitError';
	}
}

// The clone URL is user-supplied, so every request (and redirect hop) goes
// through safeFetch's private-address guard instead of isomorphic-git's
// unguarded node client. Response bytes count against one shared budget.
export function guardedHttp(maxBytes = MAX_IMPORT_DOWNLOAD_BYTES): HttpClient {
	let received = 0;
	return {
		async request({ url, method = 'GET', headers = {}, body, signal }) {
			let payload: Uint8Array<ArrayBuffer> | undefined;
			if (body) {
				const chunks: Uint8Array[] = [];
				for await (const chunk of body) chunks.push(chunk);
				payload = new Uint8Array(Buffer.concat(chunks));
			}
			const res = await safeFetch(url, { method, headers, body: payload, signal });
			async function* iterate(): AsyncGenerator<Uint8Array> {
				if (!res.body) return;
				for await (const chunk of res.body) {
					received += chunk.byteLength;
					if (received > maxBytes) {
						throw new ImportLimitError(`${maxBytes / 1024 / 1024} MB download`);
					}
					yield chunk;
				}
			}
			return {
				url: res.url || url,
				method,
				statusCode: res.status,
				statusMessage: res.statusText,
				headers: Object.fromEntries(res.headers.entries()),
				body: iterate()
			};
		}
	};
}

// A repo can contain symlinks (mode 120000) pointing anywhere on the host;
// materialize them as plain files holding the link target so nothing we later
// read, rewrite or copy can escape the temp checkout. Checked-out files (not
// git's own `.git` data, bounded by the download limit) count against the
// file-count and size limits, aborting the clone as soon as one is exceeded.
export function limitedCheckoutFs(
	dir: string,
	limits = { maxFiles: MAX_IMPORT_FILES, maxBytes: MAX_IMPORT_CHECKOUT_BYTES }
) {
	let files = 0;
	let bytes = 0;
	const gitDir = path.join(dir, '.git') + path.sep;
	const count = (file: string, size: number) => {
		if (path.resolve(file).startsWith(gitDir)) return;
		files++;
		bytes += size;
		if (files > limits.maxFiles) throw new ImportLimitError(`${limits.maxFiles} files`);
		if (bytes > limits.maxBytes) {
			throw new ImportLimitError(`${limits.maxBytes / 1024 / 1024} MB of files`);
		}
	};
	return {
		promises: {
			...fs.promises,
			writeFile: (file: string, data: string | Uint8Array, options?: unknown) => {
				count(file, typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength);
				return fs.promises.writeFile(file, data, options as fs.WriteFileOptions);
			},
			symlink: (target: string, file: string) => {
				count(file, Buffer.byteLength(target));
				return fs.promises.writeFile(file, target);
			}
		}
	};
}

function assertCloneUrl(gitUrl: string): void {
	let url: URL;
	try {
		url = new URL(gitUrl);
	} catch {
		throw new Error('Invalid git URL');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new Error('Only http(s) git URLs are supported');
	}
	// isomorphic-git appends "/info/refs?..." — a hash or query would let the
	// caller pick the exact path requested.
	if (url.hash || url.search || gitUrl.includes('#') || gitUrl.includes('?')) {
		throw new Error('Git URL must not contain a query or fragment');
	}
}

// Re-import preserves locally-added files carrying the `.local` suffix
// (e.g. `notes.md.local`) by leaving them untouched — we only overwrite
// files that come from the repo.
async function copySkillDir(src: string, dest: string): Promise<void> {
	await fsp.cp(src, dest, {
		recursive: true,
		filter: (source) => !source.endsWith(LOCAL_SUFFIX)
	});
}

export async function importSkillsFromGit(input: GitImportInput): Promise<GitImportResult> {
	const scope = input.scope ?? 'user';
	const urlParts = parseGitUrl(input.gitUrl);
	const gitUrl = urlParts.gitUrl;
	const branch = input.branch ?? urlParts.branch;
	const repoPath = input.path ?? urlParts.path;
	assertCloneUrl(gitUrl);
	const tmp = await fsp.realpath(
		await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-chat-skill-import-'))
	);
	try {
		await git.clone({
			fs: limitedCheckoutFs(tmp),
			http: guardedHttp(),
			dir: tmp,
			url: gitUrl,
			ref: branch,
			singleBranch: true,
			depth: 1
		});

		const subdir = repoPath?.replace(/^\/+|\/+$/g, '') ?? '';
		if (subdir.split('/').some((s) => s === '..' || s === '.')) {
			throw new Error('Invalid path inside repo');
		}
		const srcRoot = path.resolve(tmp, subdir);
		if (srcRoot !== tmp && !srcRoot.startsWith(tmp + path.sep)) {
			throw new Error('Invalid path inside repo');
		}
		const realRoot = await fsp.realpath(srcRoot).catch(() => null);
		if (!realRoot) throw new Error(`Path not found in repo: ${subdir || '/'}`);
		if (realRoot !== tmp && !realRoot.startsWith(tmp + path.sep)) {
			throw new Error('Invalid path inside repo');
		}

		// Discover skill directories: any dir containing a skill.md/SKILL.md.
		const skillDirs: string[] = [];
		const entries = await fsp.readdir(srcRoot, { withFileTypes: true });
		if (await findSkillFile(srcRoot)) {
			skillDirs.push(srcRoot);
		} else {
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const dir = path.join(srcRoot, entry.name);
				if (await findSkillFile(dir)) skillDirs.push(dir);
			}
		}
		if (skillDirs.length === 0) throw new Error('No skill.md found at the given path');

		const repoNames = new Set<string>();
		const destRoot = skillsRoot(scope, input.userId);
		const result: GitImportResult = { imported: [], skipped: [] };
		for (const dir of skillDirs) {
			const dirName = path.basename(dir);
			const srcSkillFile = (await findSkillFile(dir))!;
			let name = dirName;
			let invalid: string | null = null;
			try {
				const parsed = parseFrontmatter(await fsp.readFile(srcSkillFile, 'utf8'));
				const fm = parseSkillFrontmatter(parsed.data);
				name = fm.name;
				if (fm.name !== dirName)
					invalid = `frontmatter name "${fm.name}" != directory "${dirName}"`;
			} catch (e) {
				invalid = e instanceof Error ? e.message : String(e);
			}
			if (!invalid && !isValidSkillName(name)) invalid = `invalid skill name "${name}"`;
			if (!invalid && repoNames.has(name)) invalid = `duplicate skill name "${name}" in repo`;
			if (invalid) {
				result.skipped.push({ name: dirName, reason: invalid });
				continue;
			}
			repoNames.add(name);
			const dest = path.join(destRoot, name);
			const existed = await fsp.access(dest).then(
				() => true,
				() => false
			);
			// Stamp the source so re-imports from the same repo are recognizable,
			// and normalize the file to lowercase skill.md.
			const parsed = parseFrontmatter(await fsp.readFile(srcSkillFile, 'utf8'));
			parsed.data.source = `git:${gitUrl}`;
			parsed.data.title ??= name
				.split('-')
				.filter(Boolean)
				.map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
				.join(' ');
			await fsp.writeFile(srcSkillFile, matter.stringify(parsed.content, parsed.data));
			if (path.basename(srcSkillFile) !== 'skill.md') {
				await fsp.rename(srcSkillFile, path.join(dir, 'skill.md'));
			}
			await copySkillDir(dir, dest);
			result.imported.push({ name, action: existed ? 'updated' : 'created' });
		}
		return result;
	} finally {
		await fsp.rm(tmp, { recursive: true, force: true });
	}
}
