import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import matter from 'gray-matter';
import { walk } from '../mcp/servers/shared.js';
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

// Re-import preserves locally-added files carrying the `.local` suffix
// (e.g. `notes.md.local`) by leaving them untouched — we only overwrite
// files that come from the repo.
function copySkillDir(src: string, dest: string): void {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of walk(src)) {
		const target = path.join(dest, entry.rel);
		if (entry.isDir) {
			fs.mkdirSync(target, { recursive: true });
			continue;
		}
		if (entry.rel.endsWith(LOCAL_SUFFIX)) continue;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(entry.abs, target);
	}
}

export async function importSkillsFromGit(input: GitImportInput): Promise<GitImportResult> {
	const scope = input.scope ?? 'user';
	const urlParts = parseGitUrl(input.gitUrl);
	const gitUrl = urlParts.gitUrl;
	const branch = input.branch ?? urlParts.branch;
	const repoPath = input.path ?? urlParts.path;
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-skill-import-'));
	try {
		await git.clone({
			fs,
			http,
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
		if (!fs.existsSync(srcRoot)) throw new Error(`Path not found in repo: ${subdir || '/'}`);

		// Discover skill directories: any dir containing a skill.md/SKILL.md.
		const skillDirs: string[] = [];
		const entries = fs.readdirSync(srcRoot, { withFileTypes: true });
		if (findSkillFile(srcRoot)) {
			skillDirs.push(srcRoot);
		} else {
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const dir = path.join(srcRoot, entry.name);
				if (findSkillFile(dir)) skillDirs.push(dir);
			}
		}
		if (skillDirs.length === 0) throw new Error('No skill.md found at the given path');

		const repoNames = new Set<string>();
		const destRoot = skillsRoot(scope, input.userId);
		const result: GitImportResult = { imported: [], skipped: [] };
		for (const dir of skillDirs) {
			const dirName = path.basename(dir);
			const srcSkillFile = findSkillFile(dir)!;
			let name = dirName;
			let invalid: string | null = null;
			try {
				const parsed = matter(fs.readFileSync(srcSkillFile, 'utf8'));
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
			const existed = fs.existsSync(dest);
			// Stamp the source so re-imports from the same repo are recognizable,
			// and normalize the file to lowercase skill.md.
			const parsed = matter(fs.readFileSync(srcSkillFile, 'utf8'));
			parsed.data.source = `git:${gitUrl}`;
			parsed.data.title ??= name
				.split('-')
				.filter(Boolean)
				.map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
				.join(' ');
			fs.writeFileSync(srcSkillFile, matter.stringify(parsed.content, parsed.data));
			if (path.basename(srcSkillFile) !== 'skill.md') {
				fs.renameSync(srcSkillFile, path.join(dir, 'skill.md'));
			}
			copySkillDir(dir, dest);
			result.imported.push({ name, action: existed ? 'updated' : 'created' });
		}
		return result;
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}
