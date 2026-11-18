import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { openDatabase } = await import('../index.js');
const repo = await import('./mcp-servers.js');

describe('mcp-servers repo', () => {
	let db: ReturnType<typeof openDatabase>;

	beforeEach(() => {
		db = openDatabase(':memory:');
	});

	it('seeds the bundled servers', () => {
		const names = repo.listMcpServers(db).map((r) => r.name);
		expect(names).toEqual(
			expect.arrayContaining(['webfetch', 'datetime', 'chat-search', 'fs', 'subagents', 'coding'])
		);
		expect(names).not.toContain('settings');
		expect(names).not.toContain('wait');
		expect(names).not.toContain('bash');
		expect(names).not.toContain('documents');
		expect(repo.listMcpServers(db).every((r) => r.builtin === 1)).toBe(true);
	});

	it('records tool count and token estimate, exposed on the public shape', () => {
		const created = repo.createMcpServer(db, {
			name: 'measured',
			transport: 'http',
			url: 'https://mcp.example.com'
		});
		expect(repo.toPublic(created).toolTokens).toBeNull();
		repo.setMcpToolStats(db, created.id, 3, 420);
		let pub = repo.toPublic(repo.getMcpServer(db, created.id)!);
		expect(pub).toMatchObject({ toolCount: 3, toolTokens: 420 });
		// A changed estimate alone is still written.
		repo.setMcpToolStats(db, created.id, 3, 512);
		pub = repo.toPublic(repo.getMcpServer(db, created.id)!);
		expect(pub.toolTokens).toBe(512);
	});

	it('creates, reads and deletes a remote server', () => {
		const created = repo.createMcpServer(db, {
			name: 'remote',
			transport: 'http',
			url: 'https://mcp.example.com',
			token: 'secret-token'
		});
		expect(created.token_enc).toBeTruthy();
		expect(created.token_enc).not.toBe('secret-token');
		const pub = repo.toPublic(repo.getMcpServer(db, created.id)!);
		expect(pub.hasToken).toBe(true);
		expect(repo.deleteMcpServer(db, created.id)).toBe(true);
		expect(repo.getMcpServer(db, created.id)).toBeUndefined();
	});

	it('stores command and args for stdio servers', () => {
		const created = repo.createMcpServer(db, {
			name: 'local',
			transport: 'stdio',
			command: 'node',
			args: ['server.js', '--flag']
		});
		expect(repo.toPublic(created)).toMatchObject({
			transport: 'stdio',
			command: 'node',
			args: ['server.js', '--flag'],
			url: null,
			hasToken: false
		});
		const updated = repo.updateMcpServer(db, created.id, { args: ['other.js'] })!;
		expect(repo.toPublic(updated).args).toEqual(['other.js']);
		expect(updated.command).toBe('node');
	});

	it('parseMcpArgs tolerates malformed values', () => {
		expect(repo.parseMcpArgs('not json')).toEqual([]);
		expect(repo.parseMcpArgs('{"a":1}')).toEqual([]);
		expect(repo.parseMcpArgs('["a",1,"b"]')).toEqual(['a', 'b']);
	});

	it('refuses to delete builtin servers', () => {
		expect(repo.deleteMcpServer(db, 'builtin-fs')).toBe(false);
		expect(repo.getMcpServer(db, 'builtin-fs')).toBeDefined();
	});

	it('updates enabled on builtin, ignores name/url changes', () => {
		const updated = repo.updateMcpServer(db, 'builtin-fs', {
			name: 'renamed',
			url: 'https://evil.example.com',
			enabled: false
		})!;
		expect(updated.name).toBe('fs');
		expect(updated.url).toBeNull();
		expect(updated.enabled).toBe(0);
	});

	it('listEnabledMcpServers filters by enabled only', () => {
		repo.updateMcpServer(db, 'builtin-fs', { enabled: false });
		const names = repo.listEnabledMcpServers(db, 'u1').map((r) => r.name);
		expect(names).not.toContain('fs');
		expect(names).toContain('webfetch');
	});

	it('offers personal servers only to their owner', () => {
		db.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
			 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'), ('u2', 'd@e.f', 'D', 0, 0, 0, 'user')`
		).run();
		const mine = repo.createMcpServer(db, {
			name: 'mine',
			transport: 'http',
			url: 'https://mcp.example.com',
			ownerUserId: 'u1'
		});
		expect(repo.toPublic(mine).personal).toBe(true);
		expect(repo.listEnabledMcpServers(db, 'u1').map((r) => r.name)).toContain('mine');
		expect(repo.listEnabledMcpServers(db, 'u2').map((r) => r.name)).not.toContain('mine');
		expect(repo.isMcpServerVisibleTo(mine, 'u2')).toBe(false);
		// Shared servers (every builtin) are everyone's.
		expect(repo.listEnabledMcpServers(db, 'u2').map((r) => r.name)).toContain('webfetch');
	});

	it('rejects duplicate names', () => {
		expect(() =>
			repo.createMcpServer(db, { name: 'fs', transport: 'http', url: 'https://x.example.com' })
		).toThrow();
	});
});
