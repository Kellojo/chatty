import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { getDb, closeDb } = await import('../db/index.js');
const { buildTools } = await import('./registry.js');
const repo = await import('../db/repo/mcp-servers.js');

function seedUser(id: string, role: string) {
	getDb()
		.prepare(
			'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, 0, 0, ?)'
		)
		.run(id, 'A', `${id}@example.com`, role);
}

describe('tools registry', () => {
	beforeEach(() => {
		closeDb();
		seedUser('u1', 'user');
	});

	it('builds tools from all enabled builtin servers in chat mode', async () => {
		const built = await buildTools({ userId: 'u1', mode: 'chat', memoryEnabled: true });
		const names = Object.keys(built.tools);
		for (const expected of [
			'fetch',
			'now',
			'search_chats',
			'fs_read',
			'fs_ls',
			'get_setting',
			'search_memory',
			'create_concept'
		]) {
			expect(names).toContain(expected);
		}
		expect(built.toolToServer.now).toBe('datetime');
		expect(built.toolToServer.fs_ls).toBe('fs');
		expect(built.toolToServer.search_memory).toBe('memory');
		await built.close();
	});

	it('skips disabled servers', async () => {
		repo.updateMcpServer(getDb(), 'builtin-fs', { enabled: false });
		const built = await buildTools({ userId: 'u1', mode: 'chat', memoryEnabled: true });
		expect(Object.keys(built.tools)).not.toContain('fs_ls');
		expect(Object.keys(built.tools)).toContain('now');
		await built.close();
	});

	it('honors per-server mode scopes', async () => {
		repo.updateMcpServer(getDb(), 'builtin-settings', { scopes: ['agent'] });
		const chat = await buildTools({ userId: 'u1', mode: 'chat', memoryEnabled: true });
		expect(Object.keys(chat.tools)).not.toContain('get_setting');
		await chat.close();
		const agent = await buildTools({ userId: 'u1', mode: 'agent', memoryEnabled: true });
		expect(Object.keys(agent.tools)).toContain('get_setting');
		await agent.close();
	});

	it('applies the agent allowlist', async () => {
		const built = await buildTools({
			userId: 'u1',
			mode: 'agent',
			memoryEnabled: true,
			agentAllowlist: ['now', 'fs_ls', 'nonexistent']
		});
		expect(Object.keys(built.tools).sort()).toEqual(['fs_ls', 'now']);
		await built.close();
	});

	it('excludes memory tools when memoryEnabled=false', async () => {
		const built = await buildTools({ userId: 'u1', mode: 'chat', memoryEnabled: false });
		expect(Object.keys(built.tools)).toContain('now');
		expect(Object.keys(built.tools)).not.toContain('search_memory');
		await built.close();
	});

	it('skips unreachable remote servers without failing the build', async () => {
		repo.createMcpServer(getDb(), {
			name: 'dead-remote',
			transport: 'http',
			url: 'http://127.0.0.1:1/mcp'
		});
		const built = await buildTools({ userId: 'u1', mode: 'chat', memoryEnabled: true });
		expect(Object.keys(built.tools)).toContain('now');
		await built.close();
	});
});
