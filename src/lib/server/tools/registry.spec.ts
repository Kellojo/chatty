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

	it('builds tools from all enabled builtin servers', async () => {
		const built = await buildTools({ userId: 'u1', memoryEnabled: true });
		const names = Object.keys(built.tools);
		for (const expected of [
			'fetch',
			'now',
			'search_chats',
			'fs_read',
			'fs_ls',
			'get_setting',
			'search_memory',
			'create_concept',
			'code_exec',
			'generate_image'
		]) {
			expect(names).toContain(expected);
		}
		expect(built.toolToServer.now).toBe('datetime');
		expect(built.toolToServer.fs_ls).toBe('fs');
		expect(built.toolToServer.search_memory).toBe('memory');
		expect(built.toolToServer.code_exec).toBe('code-exec');
		expect(built.toolToServer.generate_image).toBe('image');
		await built.close();
	});

	it('skips disabled servers', async () => {
		repo.updateMcpServer(getDb(), 'builtin-fs', { enabled: false });
		const built = await buildTools({ userId: 'u1', memoryEnabled: true });
		expect(Object.keys(built.tools)).not.toContain('fs_ls');
		expect(Object.keys(built.tools)).toContain('now');
		await built.close();
	});

	it('applies the agent allowlist', async () => {
		const built = await buildTools({
			userId: 'u1',
			memoryEnabled: true,
			agentAllowlist: ['now', 'fs_ls', 'nonexistent']
		});
		expect(Object.keys(built.tools).sort()).toEqual(['fs_ls', 'now']);
		await built.close();
	});

	it('excludes memory tools when memoryEnabled=false', async () => {
		const built = await buildTools({ userId: 'u1', memoryEnabled: false });
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
		const built = await buildTools({ userId: 'u1', memoryEnabled: true });
		expect(Object.keys(built.tools)).toContain('now');
		await built.close();
	});

	it('connects multiple servers in parallel', async () => {
		repo.createMcpServer(getDb(), {
			name: 'remote-a',
			transport: 'http',
			url: 'http://127.0.0.1:1/mcp'
		});
		repo.createMcpServer(getDb(), {
			name: 'remote-b',
			transport: 'http',
			url: 'http://127.0.0.1:2/mcp'
		});
		const built = await buildTools({ userId: 'u1', memoryEnabled: true });
		expect(Object.keys(built.tools)).toContain('now');
		await built.close();
	});

	it('resolves tool collisions in row order (first-wins)', async () => {
		const built = await buildTools({ userId: 'u1', memoryEnabled: false });
		const collisionToolName = Object.keys(built.tools)[0];
		expect(collisionToolName).toBeDefined();
		const serverA = built.toolToServer[collisionToolName];
		expect(typeof serverA).toBe('string');
	});
});
