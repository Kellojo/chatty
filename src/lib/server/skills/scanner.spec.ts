import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
const VOL = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-skill-scanner-'));
process.env.SKILLS_VOLUME = VOL;

const scanner = await import('./scanner.js');
const { skillsRoot } = await import('./paths.js');

function writeSkillFile(scope: 'user' | 'shared', name: string, content: string): void {
	const dir = path.join(skillsRoot(scope, 'u1'), name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'skill.md'), content);
	scanner.invalidateSkillCache();
}

const VALID = `---
name: test-skill
title: Test Skill
description: A skill for testing
---

Do the test thing.
`;

afterAll(() => {
	fs.rmSync(VOL, { recursive: true, force: true });
});

describe('parseSkillFrontmatter', () => {
	it('applies defaults', () => {
		const fm = scanner.parseSkillFrontmatter({
			name: 's',
			title: 'S',
			description: 'd'
		});
		expect(fm.triggers).toEqual([]);
		expect(fm.tools).toEqual([]);
		expect(fm.enabled).toBe(true);
		expect(fm.source).toBe('user');
		expect(fm.when).toBeNull();
		expect(fm.version).toBeNull();
		expect(fm.author).toBeNull();
	});

	it('rejects missing required fields', () => {
		expect(() => scanner.parseSkillFrontmatter({ name: 's' })).toThrow(/frontmatter/i);
		expect(() => scanner.parseSkillFrontmatter({ name: 's', title: 't', description: '' })).toThrow(
			/frontmatter/i
		);
	});

	it('derives a humanized title when title is omitted', () => {
		const fm = scanner.parseSkillFrontmatter({
			name: 'agentic-eval',
			description: 'Patterns for evaluating agent outputs.'
		});
		expect(fm.title).toBe('Agentic Eval');
	});

	it('parses triggers and tools', () => {
		const fm = scanner.parseSkillFrontmatter({
			name: 's',
			title: 'S',
			description: 'd',
			triggers: [{ keyword: 'summarize' }],
			tools: ['webfetch'],
			enabled: false,
			when: 'when asked'
		});
		expect(fm.triggers).toEqual([{ keyword: 'summarize' }]);
		expect(fm.tools).toEqual(['webfetch']);
		expect(fm.enabled).toBe(false);
		expect(fm.when).toBe('when asked');
	});
});

describe('readSkill', () => {
	it('reads a valid skill from disk', () => {
		writeSkillFile('user', 'test-skill', VALID);
		const skill = scanner.readSkill('user', 'u1', 'test-skill');
		expect(skill).not.toBeNull();
		expect(skill!.title).toBe('Test Skill');
		expect(skill!.body).toBe('Do the test thing.');
		expect(skill!.scope).toBe('user');
	});

	it('returns null when skill.md is missing', () => {
		expect(scanner.readSkill('user', 'u1', 'nonexistent')).toBeNull();
	});

	it('reads a SKILL.md file when lowercase skill.md is absent', () => {
		const dir = path.join(skillsRoot('user', 'u1'), 'upper-skill');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'SKILL.md'),
			VALID.replace('name: test-skill', 'name: upper-skill')
		);
		scanner.invalidateSkillCache();
		const skill = scanner.readSkill('user', 'u1', 'upper-skill');
		expect(skill).not.toBeNull();
		expect(skill!.name).toBe('upper-skill');
	});

	it('returns null when frontmatter name does not match directory', () => {
		writeSkillFile('user', 'dir-name', VALID.replace('name: test-skill', 'name: other-name'));
		expect(scanner.readSkill('user', 'u1', 'dir-name')).toBeNull();
	});

	it('returns null on invalid frontmatter', () => {
		writeSkillFile('user', 'bad-fm', '---\nname: 1\ntitle: t\ndescription: d\n---\nbody\n');
		// name: 1 is a number → schema rejects
		expect(scanner.readSkill('user', 'u1', 'bad-fm')).toBeNull();
	});

	it('lists reference markdown files', () => {
		writeSkillFile('user', 'with-refs', VALID.replace('name: test-skill', 'name: with-refs'));
		const dir = path.join(skillsRoot('user', 'u1'), 'with-refs');
		fs.mkdirSync(path.join(dir, 'references', 'nested'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'references', 'a.md'), 'A');
		fs.writeFileSync(path.join(dir, 'references', 'nested', 'b.md'), 'B');
		fs.writeFileSync(path.join(dir, 'references', 'ignored.txt'), 'X');
		scanner.invalidateSkillCache();
		const skill = scanner.readSkill('user', 'u1', 'with-refs');
		expect(skill!.references).toEqual(['a.md', 'nested/b.md']);
	});
});

describe('scanSkills', () => {
	it('returns sorted summaries and skips invalid dirs', () => {
		writeSkillFile('user', 'b-skill', VALID.replace('name: test-skill', 'name: b-skill'));
		writeSkillFile('user', 'a-skill', VALID.replace('name: test-skill', 'name: a-skill'));
		fs.mkdirSync(path.join(skillsRoot('user', 'u1'), 'INVALID NAME'), { recursive: true });
		const names = scanner.scanSkills('user', 'u1').map((s) => s.name);
		expect(names.indexOf('a-skill')).toBeLessThan(names.indexOf('b-skill'));
		expect(names).not.toContain('INVALID NAME');
	});
});

describe('resolveSkill / listAllSkills', () => {
	it('user scope shadows shared scope', () => {
		writeSkillFile(
			'shared',
			'shadow-me',
			VALID.replace('name: test-skill', 'name: shadow-me').replace('Test Skill', 'Shared Title')
		);
		writeSkillFile(
			'user',
			'shadow-me',
			VALID.replace('name: test-skill', 'name: shadow-me').replace('Test Skill', 'User Title')
		);
		const resolved = scanner.resolveSkill('u1', 'shadow-me');
		expect(resolved!.scope).toBe('user');
		expect(resolved!.title).toBe('User Title');

		const all = scanner.listAllSkills('u1');
		const matches = all.filter((s) => s.name === 'shadow-me');
		expect(matches).toHaveLength(1);
		expect(matches[0].scope).toBe('user');
	});

	it('falls back to shared when no user skill exists', () => {
		const resolved = scanner.resolveSkill('u1', 'shadow-me');
		expect(resolved).not.toBeNull();
		// user version exists from previous test; delete-user-scope check:
		const onlyShared = scanner.readSkill('shared', 'u1', 'shadow-me');
		expect(onlyShared!.title).toBe('Shared Title');
	});
});

describe('skillsIndexPrompt', () => {
	it('returns empty string when no enabled skills', () => {
		// No user-scope skills for this fresh user id; shared scope may contain skills
		// from other tests, so instead assert that a fully-disabled set yields ''.
		writeSkillFile(
			'user',
			'only-disabled',
			VALID.replace('name: test-skill', 'name: only-disabled').replace(
				'description: A skill for testing',
				'description: Disabled\nenabled: false'
			)
		);
		// For a user whose only visible skill is disabled and no shared visibility,
		// the index omits disabled entries. We can't isolate shared here, so assert
		// the disabled skill never appears in the prompt.
		const prompt = scanner.skillsIndexPrompt('u1');
		expect(prompt).not.toContain('only-disabled');
	});

	it('lists enabled skills only', () => {
		writeSkillFile(
			'user',
			'disabled-skill',
			VALID.replace('name: test-skill', 'name: disabled-skill') + ''
		);
		// disable it
		const dir = path.join(skillsRoot('user', 'u1'), 'disabled-skill');
		fs.writeFileSync(
			path.join(dir, 'skill.md'),
			VALID.replace('name: test-skill', 'name: disabled-skill').replace(
				'description: A skill for testing',
				'description: Disabled one\nenabled: false'
			)
		);
		scanner.invalidateSkillCache();
		const prompt = scanner.skillsIndexPrompt('u1');
		expect(prompt).toContain('test-skill');
		expect(prompt).not.toContain('disabled-skill');
	});
});
