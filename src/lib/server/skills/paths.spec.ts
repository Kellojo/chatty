import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.MEMORY_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-skill-paths-'));

const paths = await import('./paths.js');

describe('isValidSkillName', () => {
	it('accepts lowercase alphanumeric with dashes', () => {
		expect(paths.isValidSkillName('summarize')).toBe(true);
		expect(paths.isValidSkillName('draft-email')).toBe(true);
		expect(paths.isValidSkillName('a1')).toBe(true);
		expect(paths.isValidSkillName('skill-2-3')).toBe(true);
	});

	it('rejects uppercase, underscores, dots, spaces', () => {
		expect(paths.isValidSkillName('Skill')).toBe(false);
		expect(paths.isValidSkillName('my_skill')).toBe(false);
		expect(paths.isValidSkillName('my.skill')).toBe(false);
		expect(paths.isValidSkillName('my skill')).toBe(false);
	});

	it('rejects leading dash, empty, and overly long names', () => {
		expect(paths.isValidSkillName('-skill')).toBe(false);
		expect(paths.isValidSkillName('')).toBe(false);
		expect(paths.isValidSkillName('a'.repeat(65))).toBe(false);
	});

	it('rejects path traversal attempts', () => {
		expect(paths.isValidSkillName('..')).toBe(false);
		expect(paths.isValidSkillName('../x')).toBe(false);
		expect(paths.isValidSkillName('a/b')).toBe(false);
		expect(paths.isValidSkillName('a\\b')).toBe(false);
	});
});

describe('skillsRoot', () => {
	it('resolves user scope under the user id', () => {
		const root = paths.skillsRoot('user', 'u1');
		expect(root).toBe(path.join(path.resolve(process.env.MEMORY_VOLUME!), 'u1', 'skills'));
	});

	it('resolves shared scope under shared/', () => {
		const root = paths.skillsRoot('shared', 'u1');
		expect(root).toBe(path.join(path.resolve(process.env.MEMORY_VOLUME!), 'shared', 'skills'));
	});
});

describe('resolveSkillDir', () => {
	it('returns the absolute dir for a valid name', () => {
		const dir = paths.resolveSkillDir('user', 'u1', 'my-skill');
		expect(dir).toBe(path.join(paths.skillsRoot('user', 'u1'), 'my-skill'));
	});

	it('returns null for invalid names', () => {
		expect(paths.resolveSkillDir('user', 'u1', '..')).toBeNull();
		expect(paths.resolveSkillDir('user', 'u1', '../escape')).toBeNull();
		expect(paths.resolveSkillDir('user', 'u1', 'UPPER')).toBeNull();
	});
});

describe('resolveSkillReference', () => {
	it('accepts a simple nested posix path', () => {
		const abs = paths.resolveSkillReference('user', 'u1', 's1', 'references/examples.md');
		expect(abs).toBe(path.join(paths.skillsRoot('user', 'u1'), 's1', 'references', 'examples.md'));
	});

	it('rejects traversal segments', () => {
		expect(paths.resolveSkillReference('user', 'u1', 's1', '../secret.md')).toBeNull();
		expect(paths.resolveSkillReference('user', 'u1', 's1', 'a/../../b.md')).toBeNull();
		expect(paths.resolveSkillReference('user', 'u1', 's1', '..\\secret.md')).toBeNull();
	});

	it('rejects absolute paths', () => {
		expect(paths.resolveSkillReference('user', 'u1', 's1', '/etc/passwd')).toBeNull();
		expect(paths.resolveSkillReference('user', 'u1', 's1', 'C:\\abs\\x.md')).toBeNull();
	});

	it('rejects empty and dot segments', () => {
		expect(paths.resolveSkillReference('user', 'u1', 's1', '')).toBeNull();
		expect(paths.resolveSkillReference('user', 'u1', 's1', 'a//b.md')).toBeNull();
		expect(paths.resolveSkillReference('user', 'u1', 's1', './a.md')).toBeNull();
	});

	it('returns null when the skill name is invalid', () => {
		expect(paths.resolveSkillReference('user', 'u1', '..', 'a.md')).toBeNull();
	});
});
