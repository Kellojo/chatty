import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-skill-repo-'));

// isomorphic-git's node http client cannot clone file:// URLs; mock clone to
// copy the local source repo into the destination instead.
vi.mock('isomorphic-git', async (importOriginal) => {
	const original = await importOriginal<typeof import('isomorphic-git')>();
	return {
		...original,
		default: {
			...original,
			clone: async ({ dir }: { dir: string }) => {
				fs.cpSync(SRC, dir, { recursive: true });
			}
		}
	};
});

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
const VOL = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-skill-gitimport-'));
process.env.SKILLS_VOLUME = VOL;

const { importSkillsFromGit, parseGitUrl } = await import('./gitImport.js');
const { skillsRoot } = await import('./paths.js');
const scanner = await import('./scanner.js');

const REPO_URL = 'https://example.com/skills-repo.git';

function writeRepoFile(rel: string, content: string): void {
	const abs = path.join(SRC, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

const SKILL_A = `---
name: skill-a
title: Skill A
description: First skill
---

Body A.
`;

const SKILL_BAD_NAME = `---
name: not-the-dir
title: Mismatch
description: Name does not match directory
---

Body.
`;

const SKILL_INVALID_FM = `---
name: skill-c
---

Missing title/description.
`;

// Agent Skills convention: SKILL.md, only name + description, no title.
const SKILL_NO_TITLE = `---
name: agentic-eval
description: Patterns for evaluating agent outputs.
---

# Agentic Evaluation
`;

describe('parseGitUrl', () => {
	it('passes plain repo URLs through unchanged', () => {
		expect(parseGitUrl('https://github.com/user/repo')).toEqual({
			gitUrl: 'https://github.com/user/repo'
		});
		expect(parseGitUrl('https://github.com/user/repo.git')).toEqual({
			gitUrl: 'https://github.com/user/repo.git'
		});
		expect(parseGitUrl('git@github.com:user/repo.git')).toEqual({
			gitUrl: 'git@github.com:user/repo.git'
		});
	});

	it('parses GitHub tree URLs into repo, branch and subpath', () => {
		expect(parseGitUrl('https://github.com/user/repo/tree/main/skills')).toEqual({
			gitUrl: 'https://github.com/user/repo.git',
			branch: 'main',
			path: 'skills'
		});
		expect(parseGitUrl('https://github.com/user/repo/tree/main/skills/nested/deep')).toEqual({
			gitUrl: 'https://github.com/user/repo.git',
			branch: 'main',
			path: 'skills/nested/deep'
		});
	});

	it('parses GitHub blob URLs and drops the file name', () => {
		expect(
			parseGitUrl('https://github.com/user/repo/blob/main/skills/agentic-eval/SKILL.md')
		).toEqual({
			gitUrl: 'https://github.com/user/repo.git',
			branch: 'main',
			path: 'skills/agentic-eval'
		});
	});

	it('parses GitLab tree URLs with the /-/ separator', () => {
		expect(parseGitUrl('https://gitlab.com/user/repo/-/tree/main/skills')).toEqual({
			gitUrl: 'https://gitlab.com/user/repo.git',
			branch: 'main',
			path: 'skills'
		});
	});

	it('parses Bitbucket src URLs', () => {
		expect(parseGitUrl('https://bitbucket.org/user/repo/src/main/skills')).toEqual({
			gitUrl: 'https://bitbucket.org/user/repo.git',
			branch: 'main',
			path: 'skills'
		});
	});

	it('handles tree URLs pointing at the repo root', () => {
		expect(parseGitUrl('https://github.com/user/repo/tree/main')).toEqual({
			gitUrl: 'https://github.com/user/repo.git',
			branch: 'main',
			path: undefined
		});
	});

	it('returns non-URL input unchanged', () => {
		expect(parseGitUrl('not a url')).toEqual({ gitUrl: 'not a url' });
	});
});

beforeAll(() => {
	writeRepoFile('skills/skill-a/skill.md', SKILL_A);
	writeRepoFile('skills/skill-a/references/examples.md', '# Examples\n');
	writeRepoFile('skills/skill-b/skill.md', SKILL_BAD_NAME);
	writeRepoFile('skills/skill-c/skill.md', SKILL_INVALID_FM);
	writeRepoFile('skills/not-a-skill/README.md', 'no skill.md here');
	writeRepoFile(
		'single/skill.md',
		SKILL_A.replace('name: skill-a', 'name: single').replace('Skill A', 'Single')
	);
	writeRepoFile('skills/agentic-eval/SKILL.md', SKILL_NO_TITLE);
});

afterAll(() => {
	fs.rmSync(VOL, { recursive: true, force: true });
	fs.rmSync(SRC, { recursive: true, force: true });
});

describe('importSkillsFromGit', () => {
	it('imports valid skills, skips invalid ones', async () => {
		const result = await importSkillsFromGit({
			gitUrl: REPO_URL,
			path: 'skills',
			userId: 'u1'
		});
		expect(result.imported.map((i) => i.name).sort()).toEqual(['agentic-eval', 'skill-a']);
		expect(result.imported.find((i) => i.name === 'skill-a')?.action).toBe('created');
		const skippedNames = result.skipped.map((s) => s.name).sort();
		expect(skippedNames).toEqual(['skill-b', 'skill-c']);
		const nameMismatch = result.skipped.find((s) => s.name === 'skill-b');
		expect(nameMismatch!.reason).toContain('not-the-dir');
	});

	it('stamps source and copies reference files', async () => {
		scanner.invalidateSkillCache();
		const skill = scanner.readSkill('user', 'u1', 'skill-a');
		expect(skill).not.toBeNull();
		expect(skill!.source).toBe(`git:${REPO_URL}`);
		expect(skill!.references).toEqual(['references/examples.md']);
		const refAbs = path.join(skillsRoot('user', 'u1'), 'skill-a', 'references', 'examples.md');
		expect(fs.readFileSync(refAbs, 'utf8')).toContain('Examples');
	});

	it('imports SKILL.md files without a title, deriving a humanized title', async () => {
		scanner.invalidateSkillCache();
		const skill = scanner.readSkill('user', 'u1', 'agentic-eval');
		expect(skill).not.toBeNull();
		expect(skill!.title).toBe('Agentic Eval');
		// normalized to lowercase skill.md on disk
		expect(fs.existsSync(path.join(skillsRoot('user', 'u1'), 'agentic-eval', 'skill.md'))).toBe(
			true
		);
	});

	it('reports updated on re-import and preserves .local files', async () => {
		const localNote = path.join(skillsRoot('user', 'u1'), 'skill-a', 'notes.md.local');
		fs.writeFileSync(localNote, 'local only');
		const result = await importSkillsFromGit({
			gitUrl: REPO_URL,
			path: 'skills',
			userId: 'u1'
		});
		expect(result.imported).toEqual([
			{ name: 'agentic-eval', action: 'updated' },
			{ name: 'skill-a', action: 'updated' }
		]);
		expect(fs.readFileSync(localNote, 'utf8')).toBe('local only');
	});

	it('imports a repo root containing skill.md directly', async () => {
		const result = await importSkillsFromGit({
			gitUrl: REPO_URL,
			path: 'single',
			userId: 'u1'
		});
		expect(result.imported).toEqual([{ name: 'single', action: 'created' }]);
	});

	it('rejects traversal in path', async () => {
		await expect(
			importSkillsFromGit({ gitUrl: REPO_URL, path: '../outside', userId: 'u1' })
		).rejects.toThrow(/invalid path/i);
	});

	it('throws when path does not exist in repo', async () => {
		await expect(
			importSkillsFromGit({ gitUrl: REPO_URL, path: 'missing', userId: 'u1' })
		).rejects.toThrow(/not found/i);
	});

	it('imports into shared scope when requested', async () => {
		const result = await importSkillsFromGit({
			gitUrl: REPO_URL,
			path: 'single',
			scope: 'shared',
			userId: 'u1'
		});
		expect(result.imported).toEqual([{ name: 'single', action: 'created' }]);
		scanner.invalidateSkillCache();
		expect(scanner.readSkill('shared', 'u1', 'single')).not.toBeNull();
	});
});
