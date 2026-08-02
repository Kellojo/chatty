import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.SKILLS_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-skills-mcp-'));

const { createSkillsServer } = await import('./skills.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');
const { readSkill, resolveSkill } = await import('../../skills/scanner.js');

const userCtx = { userId: 'u1', role: 'user', workspaceDir: null, documentsDir: '' };

type Ctx = typeof userCtx;

async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createSkillsServer(ctx);
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tools = await client.tools();
		const tool = tools[name] as unknown as {
			execute: (input: unknown, opts: unknown) => Promise<unknown>;
		};
		return await tool.execute(args, { toolCallId: 't1', messages: [] });
	} finally {
		await client.close();
		await server.close();
	}
}

function resultText(res: unknown): string {
	const r = res as { content?: Array<{ type: string; text?: string }> };
	return r.content?.[0]?.text ?? '';
}

function isError(res: unknown): boolean {
	return (res as { isError?: boolean }).isError === true;
}

function skillDir(name: string): string {
	return path.join(process.env.SKILLS_VOLUME!, 'u1', name);
}

describe('skills server create/update/delete', () => {
	it('create → load → update → delete round trip', async () => {
		const created = await callTool(userCtx, 'create_skill', {
			name: 'weekly-report',
			description: 'Draft a weekly status report',
			body: '# Weekly Report\n\nSummarize progress.',
			when: 'on Fridays',
			tools: ['fetch'],
			references: [{ path: 'template.md', content: '# Template\n\n- item' }]
		});
		expect(isError(created)).toBe(false);
		expect(JSON.parse(resultText(created))).toEqual({
			name: 'weekly-report',
			title: 'Weekly Report',
			scope: 'user'
		});

		const stored = readSkill('user', 'u1', 'weekly-report');
		expect(stored?.frontmatter.when).toBe('on Fridays');
		expect(stored?.frontmatter.tools).toEqual(['fetch']);
		expect(
			fs.existsSync(path.join(skillDir('weekly-report'), 'references', 'template.md')),
			`dir contents: ${fs.readdirSync(skillDir('weekly-report'), { recursive: true })}`
		).toBe(true);
		expect(stored?.references).toEqual(['template.md']);
		expect(
			fs.readFileSync(path.join(skillDir('weekly-report'), 'references', 'template.md'), 'utf8')
		).toContain('Template');

		const loaded = await callTool(userCtx, 'load_skill', { name: 'weekly-report' });
		expect(isError(loaded)).toBe(false);
		expect(resultText(loaded)).toContain('Summarize progress.');

		const updated = await callTool(userCtx, 'update_skill', {
			name: 'weekly-report',
			body: '# Weekly Report v2\n\nBe brief.',
			enabled: false,
			when: null
		});
		expect(isError(updated), resultText(updated)).toBe(false);
		const after = readSkill('user', 'u1', 'weekly-report');
		expect(after?.body).toContain('v2');
		expect(after?.enabled).toBe(false);
		expect(after?.frontmatter.when).toBeNull();
		expect(after?.description).toBe('Draft a weekly status report');

		// disabled skills cannot be loaded
		expect(isError(await callTool(userCtx, 'load_skill', { name: 'weekly-report' }))).toBe(true);

		const deleted = await callTool(userCtx, 'delete_skill', { name: 'weekly-report' });
		expect(isError(deleted)).toBe(false);
		expect(resolveSkill('u1', 'weekly-report')).toBeNull();
		expect(fs.existsSync(skillDir('weekly-report'))).toBe(false);
	});

	it('rejects create when the name already exists', async () => {
		await callTool(userCtx, 'create_skill', {
			name: 'dup-skill',
			description: 'first',
			body: 'body'
		});
		const again = await callTool(userCtx, 'create_skill', {
			name: 'dup-skill',
			description: 'second',
			body: 'body'
		});
		expect(isError(again)).toBe(true);
		expect(resultText(again)).toContain('already exists');
	});

	it('rejects invalid names and reference paths', async () => {
		const badName = await callTool(userCtx, 'create_skill', {
			name: '../escape',
			description: 'd',
			body: 'b'
		});
		expect(isError(badName)).toBe(true);

		const badRef = await callTool(userCtx, 'create_skill', {
			name: 'ref-escape',
			description: 'd',
			body: 'b',
			references: [{ path: '../outside.md', content: 'x' }]
		});
		expect(isError(badRef)).toBe(true);
		expect(readSkill('user', 'u1', 'ref-escape')).toBeNull();
		expect(fs.existsSync(path.join(process.env.SKILLS_VOLUME!, 'u1', 'outside.md'))).toBe(false);
	});

	it('update shadows a shared skill instead of modifying it', async () => {
		const sharedDir = path.join(process.env.SKILLS_VOLUME!, 'shared', 'shared-skill');
		fs.mkdirSync(sharedDir, { recursive: true });
		fs.writeFileSync(
			path.join(sharedDir, 'skill.md'),
			'---\nname: shared-skill\ndescription: shared desc\n---\nshared body\n'
		);

		const updated = await callTool(userCtx, 'update_skill', {
			name: 'shared-skill',
			body: 'user override body'
		});
		expect(isError(updated)).toBe(false);
		expect(JSON.parse(resultText(updated)).scope).toBe('user');

		const shared = readSkill('shared', 'u1', 'shared-skill');
		expect(shared?.body).toBe('shared body');
		const user = readSkill('user', 'u1', 'shared-skill');
		expect(user?.body).toBe('user override body');
		expect(user?.description).toBe('shared desc');

		// deleting the user skill restores the shared one
		const deleted = await callTool(userCtx, 'delete_skill', { name: 'shared-skill' });
		expect(isError(deleted)).toBe(false);
		expect(readSkill('user', 'u1', 'shared-skill')).toBeNull();
		expect(resolveSkill('u1', 'shared-skill')?.scope).toBe('shared');

		// shared skill alone cannot be deleted
		const delShared = await callTool(userCtx, 'delete_skill', { name: 'shared-skill' });
		expect(isError(delShared)).toBe(true);
		expect(resultText(delShared)).toContain('shared');
	});

	it('returns an error when updating a missing skill', async () => {
		const res = await callTool(userCtx, 'update_skill', { name: 'missing-skill', body: 'x' });
		expect(isError(res)).toBe(true);
		expect(resultText(res)).toContain('not found');
	});
});
