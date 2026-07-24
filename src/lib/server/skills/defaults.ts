import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { defaultSkillsSource, findSkillFile, skillsRoot } from './paths.js';

const log = createLogger('skills');

// Copies bundled default skills into the shared bundle on boot.
// Existing skills are left untouched so admin edits survive upgrades.
export function seedDefaultSkills(): number {
	const src = defaultSkillsSource();
	if (!fs.existsSync(src)) return 0;
	const dest = skillsRoot('shared', 'system');
	let copied = 0;
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const target = path.join(dest, entry.name);
		if (findSkillFile(target)) continue;
		try {
			fs.cpSync(path.join(src, entry.name), target, { recursive: true });
			copied++;
		} catch (e) {
			log.warn(`Failed to seed default skill ${entry.name}`, {
				error: e instanceof Error ? e.message : String(e)
			});
		}
	}
	if (copied > 0) log.info(`Seeded ${copied} default skill(s) into shared bundle`);
	return copied;
}
