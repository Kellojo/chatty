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
			expect.arrayContaining(['webfetch', 'datetime', 'chat-search', 'fs', 'settings'])
		);
		expect(names).not.toContain('bash');
		expect(names).not.toContain('documents');
		expect(repo.listMcpServers(db).every((r) => r.builtin === 1)).toBe(true);
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
		expect(pub.scopes).toEqual(['chat', 'agent']);
		expect(repo.deleteMcpServer(db, created.id)).toBe(true);
		expect(repo.getMcpServer(db, created.id)).toBeUndefined();
	});

	it('refuses to delete builtin servers', () => {
		expect(repo.deleteMcpServer(db, 'builtin-fs')).toBe(false);
		expect(repo.getMcpServer(db, 'builtin-fs')).toBeDefined();
	});

	it('updates enabled/scopes on builtin, ignores name/url changes', () => {
		const updated = repo.updateMcpServer(db, 'builtin-fs', {
			name: 'renamed',
			url: 'https://evil.example.com',
			enabled: false,
			scopes: ['agent']
		})!;
		expect(updated.name).toBe('fs');
		expect(updated.url).toBeNull();
		expect(updated.enabled).toBe(0);
		expect(repo.toPublic(updated).scopes).toEqual(['agent']);
	});

	it('listEnabledMcpServers filters by enabled and mode', () => {
		repo.updateMcpServer(db, 'builtin-fs', { enabled: false });
		repo.updateMcpServer(db, 'builtin-settings', { scopes: ['agent'] });
		const chatNames = repo.listEnabledMcpServers(db, 'chat').map((r) => r.name);
		const agentNames = repo.listEnabledMcpServers(db, 'agent').map((r) => r.name);
		expect(chatNames).not.toContain('fs');
		expect(chatNames).not.toContain('settings');
		expect(agentNames).toContain('settings');
		expect(agentNames).not.toContain('fs');
	});

	it('rejects duplicate names', () => {
		expect(() =>
			repo.createMcpServer(db, { name: 'fs', transport: 'http', url: 'https://x.example.com' })
		).toThrow();
	});
});
