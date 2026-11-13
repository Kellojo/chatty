import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from '../frontmatter.js';
import { createLogger } from '../logger.js';
import {
	defaultSkillsSource,
	findSkillFile,
	resolveSkillDir,
	SKILL_FILE_NAMES,
	skillsRoot
} from './paths.js';
import { parseSkillFrontmatter, readSkill } from './scanner.js';
import { replaceSkillDir, writeSkill } from './store.js';

const log = createLogger('skills');

// Records the content hash of each default skill as last seeded, so a later
// boot can tell an untouched copy (safe to upgrade) from one an admin edited.
const MANIFEST = '.bundled.json';
// Copies replaced without a manifest record (seeded before hashes were kept).
const BACKUP_DIR = '.bundled-backup';

type Manifest = Record<string, { hash: string }>;

export interface SeedResult {
	added: string[];
	updated: string[];
	skipped: string[];
	removed: string[];
}

// Syncs bundled default skills into the shared bundle on boot: missing ones are
// added, unedited ones are upgraded to the bundled version, unedited ones no
// longer bundled are deleted, and copies an admin changed are left alone.
// Toggling a skill on/off is not an edit, and the on/off state is kept across
// upgrades.
export async function seedDefaultSkills(): Promise<SeedResult> {
	const result: SeedResult = { added: [], updated: [], skipped: [], removed: [] };
	const src = defaultSkillsSource();
	let entries;
	try {
		entries = await fsp.readdir(src, { withFileTypes: true });
	} catch {
		return result;
	}
	const dest = skillsRoot('shared', 'system');
	await fsp.mkdir(dest, { recursive: true });
	const manifestPath = path.join(dest, MANIFEST);
	const manifest = await readManifest(manifestPath);
	let manifestChanged = false;
	const bundledNames = new Set<string>();

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const name = entry.name;
		const bundledDir = path.join(src, name);
		const targetDir = path.join(dest, name);
		try {
			const bundledHash = await hashSkillDir(bundledDir);
			if (!bundledHash) continue;
			bundledNames.add(name);
			const currentHash = (await findSkillFile(targetDir)) ? await hashSkillDir(targetDir) : null;
			const recorded = manifest[name]?.hash;

			if (currentHash === bundledHash) {
				// Already current; adopt copies seeded before the manifest existed.
				if (recorded !== bundledHash) {
					manifest[name] = { hash: bundledHash };
					manifestChanged = true;
				}
				continue;
			}
			if (currentHash && recorded && currentHash !== recorded) {
				result.skipped.push(name);
				continue;
			}
			if (currentHash && !recorded) {
				// Seeded by an older version: no record of what was shipped, so keep
				// a backup in case it was edited.
				const backup = path.join(dest, BACKUP_DIR, `${name}-${Date.now()}`);
				await fsp.mkdir(path.dirname(backup), { recursive: true });
				await fsp.cp(targetDir, backup, { recursive: true });
				log.info(`Backed up previous default skill ${name} to ${backup}`);
			}

			const wasEnabled = currentHash
				? (await readSkill('shared', 'system', name))?.enabled
				: undefined;
			await replaceSkillDir(bundledDir, targetDir);
			if (wasEnabled === false) {
				const skill = await readSkill('shared', 'system', name);
				if (skill?.enabled) await writeSkill('shared', 'system', { ...skill, enabled: false });
			}
			manifest[name] = { hash: bundledHash };
			manifestChanged = true;
			(currentHash ? result.updated : result.added).push(name);
		} catch (e) {
			log.warn(`Failed to seed default skill ${name}`, {
				error: e instanceof Error ? e.message : String(e)
			});
		}
	}

	// An empty bundle means a broken install, not "every default was dropped".
	if (bundledNames.size > 0) {
		for (const name of Object.keys(manifest)) {
			if (bundledNames.has(name)) continue;
			if (await removeDroppedSkill(name, manifest[name].hash)) result.removed.push(name);
			delete manifest[name];
			manifestChanged = true;
		}
	}

	if (manifestChanged) await writeManifest(manifestPath, manifest);
	if (result.removed.length > 0) {
		log.info(`Removed default skill(s) no longer bundled: ${result.removed.join(', ')}`);
	}
	if (result.added.length > 0) log.info(`Added default skill(s): ${result.added.join(', ')}`);
	if (result.updated.length > 0) log.info(`Updated default skill(s): ${result.updated.join(', ')}`);
	if (result.skipped.length > 0) {
		log.info(`Default skill(s) with local edits left unchanged: ${result.skipped.join(', ')}`);
	}
	return result;
}

// Deletes the shared copy of a default skill that is no longer bundled, unless
// an admin edited it — then it stays as an ordinary shared skill. Either way
// the caller stops tracking it.
async function removeDroppedSkill(name: string, recordedHash: string): Promise<boolean> {
	const dir = resolveSkillDir('shared', 'system', name);
	if (!dir || !(await findSkillFile(dir))) return false;
	try {
		if ((await hashSkillDir(dir)) !== recordedHash) {
			log.info(`Default skill ${name} is no longer bundled; kept because it has local edits`);
			return false;
		}
		await fsp.rm(dir, { recursive: true, force: true });
		return true;
	} catch (e) {
		log.warn(`Failed to remove dropped default skill ${name}`, {
			error: e instanceof Error ? e.message : String(e)
		});
		return false;
	}
}

async function readManifest(file: string): Promise<Manifest> {
	try {
		const data: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
		return data && typeof data === 'object' ? (data as Manifest) : {};
	} catch {
		return {};
	}
}

async function writeManifest(file: string, manifest: Manifest): Promise<void> {
	const tmp = `${file}.tmp`;
	await fsp.writeFile(tmp, JSON.stringify(manifest, null, '\t'));
	await fsp.rename(tmp, file);
}

// Hashes every file in a skill folder. The skill file is hashed by meaning, not
// bytes — parsed frontmatter (with `enabled` ignored) plus the trimmed body — so
// the UI re-serializing it on an on/off toggle doesn't count as an edit.
export async function hashSkillDir(dir: string): Promise<string | null> {
	const files = (await fsp.readdir(dir, { recursive: true })).map((f) => f.replace(/\\/g, '/'));
	files.sort();
	const hash = createHash('sha256');
	let hasSkillFile = false;
	for (const rel of files) {
		const abs = path.join(dir, rel);
		if (!(await fsp.stat(abs)).isFile()) continue;
		const raw = await fsp.readFile(abs);
		let content: string | Buffer = raw;
		if ((SKILL_FILE_NAMES as readonly string[]).includes(rel)) {
			hasSkillFile = true;
			const parsed = parseFrontmatter(raw.toString('utf8'));
			const fm = parseSkillFrontmatter(parsed.data);
			content = JSON.stringify({
				fm: { ...fm, enabled: true },
				body: parsed.content.replace(/\r\n/g, '\n').trim()
			});
		}
		hash.update(`${rel}\0`).update(content).update('\0');
	}
	return hasSkillFile ? hash.digest('hex') : null;
}
