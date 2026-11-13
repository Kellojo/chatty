import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
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
	resolveSkill,
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

export async function writeSkill(
	scope: SkillScope,
	userId: string,
	input: WriteSkillInput
): Promise<Skill> {
	if (!isValidSkillName(input.name)) {
		throw new Error(
			'Invalid skill name: use lowercase letters, digits and dashes, starting with a letter or digit'
		);
	}
	const existing = await readSkill(scope, userId, input.name);
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
	await fsp.mkdir(dir, { recursive: true });
	await fsp.writeFile(path.join(dir, 'skill.md'), serializeSkill(frontmatter, input.body));
	const skill = await readSkill(scope, userId, input.name);
	if (!skill) throw new Error('Failed to write skill');
	return skill;
}

export async function deleteSkill(
	scope: SkillScope,
	userId: string,
	name: string
): Promise<boolean> {
	const dir = resolveSkillDir(scope, userId, name);
	if (!dir || !(await findSkillFile(dir))) return false;
	await fsp.rm(dir, { recursive: true, force: true });
	return true;
}

export async function duplicateSkill(
	userId: string,
	name: string,
	newName: string
): Promise<Skill> {
	const source = await resolveSkill(userId, name);
	if (!source) throw new Error(`Skill not found: ${name}`);
	if (await readSkill('user', userId, newName)) throw new Error(`Skill already exists: ${newName}`);
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

export async function promoteSkill(userId: string, name: string): Promise<Skill> {
	const skill = await readSkill('user', userId, name);
	if (!skill) throw new Error(`User skill not found: ${name}`);
	const destRoot = skillsRoot('shared', userId);
	await fsp.mkdir(destRoot, { recursive: true });
	const dest = resolveSkillDir('shared', userId, name);
	const src = resolveSkillDir('user', userId, name);
	if (!dest || !src) throw new Error('Invalid skill name');
	await replaceSkillDir(src, dest);
	const promoted = await readSkill('shared', userId, name);
	if (!promoted) throw new Error('Failed to promote skill');
	return promoted;
}

// Replaces dest wholesale with a copy of src (files missing from src must not
// linger): copy next to it, then swap with renames. Dot-prefixed names are
// never valid skill names, so the scanner ignores the temp folders meanwhile.
export async function replaceSkillDir(src: string, dest: string): Promise<void> {
	const suffix = `${path.basename(dest)}-${randomUUID()}`;
	const tmp = path.join(path.dirname(dest), `.replace-${suffix}`);
	const old = path.join(path.dirname(dest), `.old-${suffix}`);
	try {
		await fsp.cp(src, tmp, { recursive: true });
		const hadOld = await fsp
			.rename(dest, old)
			.then(() => true)
			.catch((e: NodeJS.ErrnoException) => {
				if (e.code === 'ENOENT') return false;
				throw e;
			});
		try {
			await fsp.rename(tmp, dest);
		} catch (e) {
			if (hadOld) await fsp.rename(old, dest);
			throw e;
		}
	} finally {
		await fsp.rm(tmp, { recursive: true, force: true });
		await fsp.rm(old, { recursive: true, force: true });
	}
}
