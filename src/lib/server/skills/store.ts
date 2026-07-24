import fs from 'node:fs';
import path from 'node:path';
import {
	findSkillFile,
	isValidSkillName,
	resolveSkillDir,
	skillsRoot,
	type SkillScope
} from './paths.js';
import {
	parseSkillFrontmatter,
	readSkill,
	serializeSkill,
	type Skill,
	type SkillFrontmatter
} from './scanner.js';

export interface WriteSkillInput {
	name: string;
	title?: string;
	description: string;
	triggers?: Array<{ keyword?: string; intent?: string }>;
	when?: string | null;
	tools?: string[];
	enabled?: boolean;
	source?: string;
	version?: string | null;
	author?: string | null;
	body: string;
}

export function writeSkill(scope: SkillScope, userId: string, input: WriteSkillInput): Skill {
	if (!isValidSkillName(input.name)) {
		throw new Error(
			'Invalid skill name: use lowercase letters, digits and dashes, starting with a letter or digit'
		);
	}
	const existing = readSkill(scope, userId, input.name);
	const frontmatter: SkillFrontmatter = parseSkillFrontmatter({
		name: input.name,
		title: input.title ?? existing?.title,
		description: input.description,
		triggers: input.triggers ?? existing?.frontmatter.triggers ?? [],
		when:
			input.when === undefined
				? (existing?.frontmatter.when ?? undefined)
				: (input.when ?? undefined),
		tools: input.tools ?? existing?.frontmatter.tools ?? [],
		enabled: input.enabled ?? existing?.frontmatter.enabled ?? true,
		source: input.source ?? existing?.frontmatter.source ?? 'user',
		version:
			input.version === undefined ? (existing?.version ?? undefined) : (input.version ?? undefined),
		author:
			input.author === undefined ? (existing?.author ?? undefined) : (input.author ?? undefined)
	});
	const dir = resolveSkillDir(scope, userId, input.name);
	if (!dir) throw new Error('Invalid skill name');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'skill.md'), serializeSkill(frontmatter, input.body));
	const skill = readSkill(scope, userId, input.name);
	if (!skill) throw new Error('Failed to write skill');
	return skill;
}

export function deleteSkill(scope: SkillScope, userId: string, name: string): boolean {
	const dir = resolveSkillDir(scope, userId, name);
	if (!dir || !findSkillFile(dir)) return false;
	fs.rmSync(dir, { recursive: true, force: true });
	return true;
}

export function duplicateSkill(userId: string, name: string, newName: string): Skill {
	const source = readSkill('user', userId, name) ?? readSkill('shared', userId, name);
	if (!source) throw new Error(`Skill not found: ${name}`);
	if (readSkill('user', userId, newName)) throw new Error(`Skill already exists: ${newName}`);
	return writeSkill('user', userId, {
		name: newName,
		title: source.title,
		description: source.description,
		triggers: source.frontmatter.triggers,
		when: source.frontmatter.when,
		tools: source.frontmatter.tools,
		enabled: source.enabled,
		version: source.version,
		author: source.author,
		body: source.body
	});
}

export function promoteSkill(userId: string, name: string): Skill {
	const skill = readSkill('user', userId, name);
	if (!skill) throw new Error(`User skill not found: ${name}`);
	const destRoot = skillsRoot('shared', userId);
	fs.mkdirSync(destRoot, { recursive: true });
	const dest = resolveSkillDir('shared', userId, name);
	const src = resolveSkillDir('user', userId, name);
	if (!dest || !src) throw new Error('Invalid skill name');
	fs.cpSync(src, dest, { recursive: true });
	const promoted = readSkill('shared', userId, name);
	if (!promoted) throw new Error('Failed to promote skill');
	return promoted;
}
