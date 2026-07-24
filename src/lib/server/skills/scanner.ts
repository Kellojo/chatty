import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { walk } from '../mcp/servers/shared.js';
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

function listReferences(dir: string): string[] {
	const refsDir = path.join(dir, 'references');
	if (!fs.existsSync(refsDir)) return [];
	try {
		return walk(refsDir)
			.filter((e) => !e.isDir && e.rel.endsWith('.md'))
			.map((e) => e.rel)
			.sort();
	} catch {
		return [];
	}
}

// cache keyed by "<dir>" with newest-file fingerprint; dir mtime alone is too coarse on NTFS
const referencesCache = new Map<string, { fingerprint: string; references: string[] }>();

function listReferencesCached(dir: string): string[] {
	const refsDir = path.join(dir, 'references');
	let entries: fs.Dirent[] = [];
	try {
		if (fs.existsSync(refsDir)) entries = fs.readdirSync(refsDir, { withFileTypes: true });
	} catch {
		entries = [];
	}
	let fingerprint = String(entries.length);
	for (const e of entries) {
		try {
			const st = fs.statSync(path.join(refsDir, e.name));
			fingerprint += `|${e.name}:${st.mtimeMs}:${st.size}`;
		} catch {
			// skip vanished entries
		}
	}
	const hit = referencesCache.get(dir);
	if (hit && hit.fingerprint === fingerprint) return hit.references;
	const references = listReferences(dir);
	referencesCache.set(dir, { fingerprint, references });
	return references;
}

// mtime-keyed cache: "<scope>:<userId>:<name>" → { mtimeMs, skill }
const cache = new Map<string, { mtimeMs: number; skill: Skill }>();

export function readSkill(scope: SkillScope, userId: string, name: string): Skill | null {
	const dir = resolveSkillDir(scope, userId, name);
	if (!dir) return null;
	const skillFile = findSkillFile(dir);
	if (!skillFile) return null;
	let stat: fs.Stats;
	try {
		stat = fs.statSync(skillFile);
	} catch {
		return null;
	}
	const key = `${scope}:${userId}:${name}`;
	const hit = cache.get(key);
	if (hit && hit.mtimeMs === stat.mtimeMs) return hit.skill;

	let skill: Skill;
	try {
		const parsed = matter(fs.readFileSync(skillFile, 'utf8'));
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
			references: listReferencesCached(dir),
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

export function scanSkills(scope: SkillScope, userId: string): SkillSummary[] {
	const root = skillsRoot(scope, userId);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: SkillSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !isValidSkillName(entry.name)) continue;
		const skill = readSkill(scope, userId, entry.name);
		if (skill) out.push(toSummary(skill));
	}
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
export function resolveSkill(userId: string, name: string): Skill | null {
	return readSkill('user', userId, name) ?? readSkill('shared', userId, name);
}

export function listAllSkills(userId: string): SkillSummary[] {
	const shared = scanSkills('shared', userId);
	const user = scanSkills('user', userId);
	const shadowed = new Set(user.map((s) => s.name));
	return [...user, ...shared.filter((s) => !shadowed.has(s.name))];
}

export function skillsIndexPrompt(userId: string): string {
	const skills = listAllSkills(userId).filter((s) => s.enabled);
	if (skills.length === 0) return '';
	const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
	return `## Available skills\nLoad a skill with the load_skill tool when the task matches its description. Reference files can be read with read_skill_reference.\n${lines.join('\n')}`;
}
