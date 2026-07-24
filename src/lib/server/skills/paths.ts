import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import type { MemoryScope } from '../memory/paths.js';

export type SkillScope = MemoryScope;

export const SKILL_FILE_NAMES = ['skill.md', 'SKILL.md'] as const;

// Returns the skill file path inside dir, preferring lowercase skill.md.
export function findSkillFile(dir: string): string | null {
	for (const name of SKILL_FILE_NAMES) {
		const abs = path.join(dir, name);
		if (fs.existsSync(abs)) return abs;
	}
	return null;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidSkillName(name: string): boolean {
	return NAME_RE.test(name);
}

export function skillsRoot(scope: SkillScope, userId: string): string {
	return path.join(
		path.resolve(config.MEMORY_VOLUME),
		scope === 'shared' ? 'shared' : userId,
		'skills'
	);
}

export function defaultSkillsSource(): string {
	return path.resolve('skills/defaults');
}

export function resolveSkillDir(scope: SkillScope, userId: string, name: string): string | null {
	if (!isValidSkillName(name)) return null;
	const root = skillsRoot(scope, userId);
	const abs = path.resolve(root, name);
	if (abs !== root && !abs.startsWith(root + path.sep)) return null;
	return abs;
}

export function resolveSkillReference(
	scope: SkillScope,
	userId: string,
	name: string,
	relPath: string
): string | null {
	const dir = resolveSkillDir(scope, userId, name);
	if (!dir) return null;
	const posix = relPath.split('\\').join('/');
	if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) return null;
	if (posix.split('/').some((s) => s === '..' || s === '.' || s.length === 0)) return null;
	const abs = path.resolve(dir, posix);
	if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
	return abs;
}
