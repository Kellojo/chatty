import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
const VOL = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-skill-defaults-'));
process.env.SKILLS_VOLUME = path.join(VOL, 'volume');
const BUNDLE = path.join(VOL, 'bundle');

vi.doMock('./paths.js', async (orig) => ({
	...(await orig<typeof import('./paths.js')>()),
	defaultSkillsSource: () => BUNDLE
}));

const { seedDefaultSkills } = await import('./defaults.js');
const { readSkill } = await import('./scanner.js');
const { writeSkill } = await import('./store.js');
const { skillsRoot } = await import('./paths.js');

const shared = () => skillsRoot('shared', 'system');

function bundle(name: string, body: string, extra: Record<string, string> = {}) {
	const dir = path.join(BUNDLE, name);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'skill.md'),
		`---\nname: ${name}\ndescription: Demo\nenabled: true\nsource: bundled\n---\n${body}\n`
	);
	for (const [rel, content] of Object.entries(extra)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), content);
	}
}

beforeEach(async () => {
	fs.rmSync(BUNDLE, { recursive: true, force: true });
	fs.rmSync(process.env.SKILLS_VOLUME!, { recursive: true, force: true });
});

afterAll(async () => {
	fs.rmSync(VOL, { recursive: true, force: true });
});

describe('seedDefaultSkills', () => {
	it('adds missing skills, then is a no-op', async () => {
		bundle('demo', 'v1');
		expect(await seedDefaultSkills()).toEqual({
			added: ['demo'],
			updated: [],
			skipped: [],
			removed: []
		});
		expect((await readSkill('shared', 'system', 'demo'))?.body).toBe('v1');
		expect(await seedDefaultSkills()).toEqual({ added: [], updated: [], skipped: [], removed: [] });
	});

	it('upgrades untouched copies and drops removed files', async () => {
		bundle('demo', 'v1', { 'references/old.md': 'old' });
		await seedDefaultSkills();
		bundle('demo', 'v2', { 'references/new.md': 'new' });
		expect((await seedDefaultSkills()).updated).toEqual(['demo']);
		const skill = await readSkill('shared', 'system', 'demo');
		expect(skill?.body).toBe('v2');
		expect(skill?.references).toEqual(['references/new.md']);
	});

	it('keeps the on/off state and treats a toggle as unedited', async () => {
		bundle('demo', 'v1');
		await seedDefaultSkills();
		const skill = (await readSkill('shared', 'system', 'demo'))!;
		await writeSkill('shared', 'system', { ...skill, enabled: false });
		bundle('demo', 'v2');
		expect((await seedDefaultSkills()).updated).toEqual(['demo']);
		const upgraded = await readSkill('shared', 'system', 'demo');
		expect(upgraded?.body).toBe('v2');
		expect(upgraded?.enabled).toBe(false);
	});

	it('leaves admin-edited copies alone', async () => {
		bundle('demo', 'v1');
		await seedDefaultSkills();
		const skill = (await readSkill('shared', 'system', 'demo'))!;
		await writeSkill('shared', 'system', { ...skill, body: 'custom' });
		bundle('demo', 'v2');
		expect((await seedDefaultSkills()).skipped).toEqual(['demo']);
		expect((await readSkill('shared', 'system', 'demo'))?.body).toBe('custom');
	});

	it('upgrades copies seeded before the manifest existed, keeping a backup', async () => {
		bundle('demo', 'v1');
		await seedDefaultSkills();
		fs.rmSync(path.join(shared(), '.bundled.json'));
		bundle('demo', 'v2');
		expect((await seedDefaultSkills()).updated).toEqual(['demo']);
		expect((await readSkill('shared', 'system', 'demo'))?.body).toBe('v2');
		const backups = fs.readdirSync(path.join(shared(), '.bundled-backup'));
		expect(backups).toHaveLength(1);
		expect(
			fs.readFileSync(path.join(shared(), '.bundled-backup', backups[0], 'skill.md'), 'utf8')
		).toContain('v1');
	});

	describe('skills dropped from the bundle', () => {
		const manifest = () =>
			JSON.parse(fs.readFileSync(path.join(shared(), '.bundled.json'), 'utf8')) as object;

		it('deletes untouched copies, also when disabled', async () => {
			bundle('keep', 'k');
			bundle('gone', 'g');
			await seedDefaultSkills();
			const skill = (await readSkill('shared', 'system', 'gone'))!;
			await writeSkill('shared', 'system', { ...skill, enabled: false });
			fs.rmSync(path.join(BUNDLE, 'gone'), { recursive: true });
			expect((await seedDefaultSkills()).removed).toEqual(['gone']);
			expect(fs.existsSync(path.join(shared(), 'gone'))).toBe(false);
			expect(await readSkill('shared', 'system', 'keep')).not.toBeNull();
			expect(manifest()).not.toHaveProperty('gone');
		});

		it('keeps edited copies as ordinary shared skills', async () => {
			bundle('keep', 'k');
			bundle('gone', 'g');
			await seedDefaultSkills();
			const skill = (await readSkill('shared', 'system', 'gone'))!;
			await writeSkill('shared', 'system', { ...skill, body: 'custom' });
			fs.rmSync(path.join(BUNDLE, 'gone'), { recursive: true });
			expect((await seedDefaultSkills()).removed).toEqual([]);
			expect((await readSkill('shared', 'system', 'gone'))?.body).toBe('custom');
			expect(manifest()).not.toHaveProperty('gone');
		});

		it('never touches shared skills that did not ship as defaults', async () => {
			bundle('keep', 'k');
			await seedDefaultSkills();
			await writeSkill('shared', 'system', { name: 'mine', description: 'Mine', body: 'x' });
			expect((await seedDefaultSkills()).removed).toEqual([]);
			expect(await readSkill('shared', 'system', 'mine')).not.toBeNull();
		});

		it('removes nothing when the bundle is empty', async () => {
			bundle('gone', 'g');
			await seedDefaultSkills();
			fs.rmSync(path.join(BUNDLE, 'gone'), { recursive: true });
			expect((await seedDefaultSkills()).removed).toEqual([]);
			expect(await readSkill('shared', 'system', 'gone')).not.toBeNull();
		});
	});
});
