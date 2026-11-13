import type { Dirent, Stats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { parseFrontmatter } from '../frontmatter.js';
import {
	findSkillFile,
	isValidSkillName,
	resolveSkillDir,
	skillsRoot,
	type SkillScope
} from './paths.js';

export interface SkillFrontmatter {
	name: string;
	title: string;
	description: string;
	triggers: Array<{ keyword?: string; intent?: string }>;
	when: string | null;
	tools: string[];
	enabled: boolean;
	source: string;
	version: string | null;
	author: string | null;
}

export interface SkillSummary {
	name: string;
	scope: SkillScope;
	title: string;
	description: string;
	enabled: boolean;
	source: string;
	version: string | null;
	author: string | null;
	references: string[];
}

export interface Skill extends SkillSummary {
	frontmatter: SkillFrontmatter;
	body: string;
}

const frontmatterSchema = z.object({
	name: z.string().trim().min(1).max(64),
	title: z.string().trim().min(1).max(120).optional(),
	description: z.string().trim().min(1).max(500),
	triggers: z
		.array(
			z.object({
				keyword: z.string().trim().min(1).max(100).optional(),
				intent: z.string().trim().min(1).max(200).optional()
			})
		)
		.max(20)
		.default([]),
	when: z.string().trim().max(500).optional(),
	tools: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
	enabled: z.boolean().default(true),
	source: z.string().trim().max(500).default('user'),
	version: z.string().trim().max(50).optional(),
	author: z.string().trim().max(120).optional()
});

function humanizeName(name: string): string {
	return name
		.split('-')
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}

export function parseSkillFrontmatter(input: unknown): SkillFrontmatter {
	const parsed = frontmatterSchema.safeParse(input);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new Error(`Invalid skill frontmatter: ${issues}`);
	}
	const fm = parsed.data;
	return {
		name: fm.name,
		title: fm.title ?? humanizeName(fm.name),
		description: fm.description,
		triggers: fm.triggers,
		when: fm.when ?? null,
		tools: fm.tools,
		enabled: fm.enabled,
		source: fm.source,
		version: fm.version ?? null,
		author: fm.author ?? null
	};
}

export function serializeSkill(frontmatter: SkillFrontmatter, body: string): string {
	const fm: Record<string, unknown> = {
		name: frontmatter.name,
		title: frontmatter.title,
		description: frontmatter.description
	};
	if (frontmatter.triggers.length > 0) fm.triggers = frontmatter.triggers;
	if (frontmatter.when) fm.when = frontmatter.when;
	if (frontmatter.tools.length > 0) fm.tools = frontmatter.tools;
	fm.enabled = frontmatter.enabled;
	fm.source = frontmatter.source;
	if (frontmatter.version) fm.version = frontmatter.version;
	if (frontmatter.author) fm.author = frontmatter.author;
	return matter.stringify(body.replace(/\r\n/g, '\n').replace(/\n*$/, '\n'), fm);
}

/** Every `.md` file under `dir`, as POSIX paths relative to it (symlinks are skipped). */
async function listMarkdownFiles(dir: string, prefix = ''): Promise<string[]> {
	const out: string[] = [];
	for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...(await listMarkdownFiles(path.join(dir, e.name), rel)));
		else if (e.isFile() && e.name.endsWith('.md')) out.push(rel);
	}
	return out;
}

async function listReferences(dir: string): Promise<string[]> {
	try {
		const files = await listMarkdownFiles(path.join(dir, 'references'));
		return files.map((rel) => `references/${rel}`).sort();
	} catch {
		return [];
	}
}

// cache keyed by "<dir>" with newest-file fingerprint; dir mtime alone is too coarse on NTFS
const referencesCache = new Map<string, { fingerprint: string; references: string[] }>();

async function listReferencesCached(dir: string): Promise<string[]> {
	const refsDir = path.join(dir, 'references');
	const entries = await fsp.readdir(refsDir, { withFileTypes: true }).catch(() => []);
	const stats = await Promise.all(
		entries.map((e) =>
			fsp
				.stat(path.join(refsDir, e.name))
				.then((st) => `|${e.name}:${st.mtimeMs}:${st.size}`)
				// skip vanished entries
				.catch(() => '')
		)
	);
	const fingerprint = String(entries.length) + stats.join('');
	const hit = referencesCache.get(dir);
	if (hit && hit.fingerprint === fingerprint) return hit.references;
	const references = await listReferences(dir);
	referencesCache.set(dir, { fingerprint, references });
	return references;
}

// mtime-keyed cache: "<scope>:<userId>:<name>" → { mtimeMs, skill }
const cache = new Map<string, { mtimeMs: number; skill: Skill }>();

export async function readSkill(
	scope: SkillScope,
	userId: string,
	name: string
): Promise<Skill | null> {
	const dir = resolveSkillDir(scope, userId, name);
	if (!dir) return null;
	const skillFile = await findSkillFile(dir);
	if (!skillFile) return null;
	let stat: Stats;
	try {
		stat = await fsp.stat(skillFile);
	} catch {
		return null;
	}
	const key = `${scope}:${userId}:${name}`;
	const hit = cache.get(key);
	if (hit && hit.mtimeMs === stat.mtimeMs) return hit.skill;

	let skill: Skill;
	try {
		const parsed = parseFrontmatter(await fsp.readFile(skillFile, 'utf8'));
		const frontmatter = parseSkillFrontmatter(parsed.data);
		if (frontmatter.name !== name) return null;
		skill = {
			name,
			scope,
			title: frontmatter.title,
			description: frontmatter.description,
			enabled: frontmatter.enabled,
			source: frontmatter.source,
			version: frontmatter.version,
			author: frontmatter.author,
			references: await listReferencesCached(dir),
			frontmatter,
			body: parsed.content.trim()
		};
	} catch {
		return null;
	}
	cache.set(key, { mtimeMs: stat.mtimeMs, skill });
	return skill;
}

export function invalidateSkillCache(): void {
	cache.clear();
	referencesCache.clear();
}

export async function scanSkills(scope: SkillScope, userId: string): Promise<SkillSummary[]> {
	const root = skillsRoot(scope, userId);
	let entries: Dirent[];
	try {
		entries = await fsp.readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const skills = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory() && isValidSkillName(entry.name))
			.map((entry) => readSkill(scope, userId, entry.name))
	);
	const out = skills.filter((s): s is Skill => s !== null).map(toSummary);
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

export function toSummary(skill: Skill): SkillSummary {
	const summary = { ...skill } as Partial<Skill>;
	delete summary.body;
	delete summary.frontmatter;
	return summary as SkillSummary;
}

// User skills shadow shared skills of the same name.
export async function resolveSkill(userId: string, name: string): Promise<Skill | null> {
	return (await readSkill('user', userId, name)) ?? (await readSkill('shared', userId, name));
}

export async function listAllSkills(userId: string): Promise<SkillSummary[]> {
	const [shared, user] = await Promise.all([
		scanSkills('shared', userId),
		scanSkills('user', userId)
	]);
	const shadowed = new Set(user.map((s) => s.name));
	return [...user, ...shared.filter((s) => !shadowed.has(s.name))];
}

export async function skillsIndexPrompt(userId: string): Promise<string> {
	const skills = (await listAllSkills(userId)).filter((s) => s.enabled);
	if (skills.length === 0) return '';
	const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
	return `## Available skills\nLoad a skill with the load_skill tool when the task matches its description. Reference files can be read with read_skill_reference.\n${lines.join('\n')}`;
}
