import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
const VOL = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-skill-store-'));
process.env.SKILLS_VOLUME = VOL;

const { promoteSkill, writeSkill } = await import('./store.js');
const { skillsRoot } = await import('./paths.js');

afterAll(async () => {
	fs.rmSync(VOL, { recursive: true, force: true });
});

describe('promoteSkill', () => {
	it('replaces the shared folder so stale files do not linger', async () => {
		await writeSkill('user', 'u1', { name: 'demo', description: 'v1', body: 'one' });
		const userDir = path.join(skillsRoot('user', 'u1'), 'demo');
		fs.writeFileSync(path.join(userDir, 'old.txt'), 'stale');
		await promoteSkill('u1', 'demo');
		const sharedDir = path.join(skillsRoot('shared', 'u1'), 'demo');
		expect(fs.existsSync(path.join(sharedDir, 'old.txt'))).toBe(true);

		fs.rmSync(path.join(userDir, 'old.txt'));
		await writeSkill('user', 'u1', { name: 'demo', description: 'v2', body: 'two' });
		const promoted = await promoteSkill('u1', 'demo');
		expect(promoted.description).toBe('v2');
		expect(fs.readdirSync(sharedDir)).toEqual(['skill.md']);
		// No temp/backup folders are left next to it.
		expect(fs.readdirSync(skillsRoot('shared', 'u1'))).toEqual(['demo']);
	});

	it('rejects invalid names', async () => {
		await expect(promoteSkill('u1', '../evil')).rejects.toThrow();
	});
});
