import { describe, expect, it } from 'vitest';
import type { McpServerRow } from '../db/repo/mcp-servers.js';
import {
	mcpServerCreateSchema,
	mcpServerPatchSchema,
	resolveMcpServerPatch
} from './serverInput.js';

function row(overrides: Partial<McpServerRow> = {}): McpServerRow {
	return {
		id: 's1',
		name: 'srv',
		transport: 'http',
		command: null,
		args: '[]',
		url: 'https://mcp.example.com',
		token_enc: 'enc',
		enabled: 1,
		builtin: 0,
		load_mode: 'always',
		auth: 'token',
		oauth_client_id: null,
		oauth_client_secret_enc: null,
		oauth_scope: null,
		oauth_client_info_enc: null,
		tool_count: null,
		...overrides
	};
}

describe('mcpServerCreateSchema', () => {
	it('accepts remote servers with a url and stdio servers with a command', () => {
		expect(
			mcpServerCreateSchema.safeParse({ name: 'a', transport: 'http', url: 'https://x.example' })
				.success
		).toBe(true);
		const stdio = mcpServerCreateSchema.safeParse({
			name: 'My Server',
			transport: 'stdio',
			command: 'npx'
		});
		expect(stdio.success && stdio.data).toMatchObject({
			name: 'my-server',
			command: 'npx',
			args: []
		});
	});

	it('rejects incomplete or unknown transports', () => {
		expect(mcpServerCreateSchema.safeParse({ name: 'a', transport: 'http' }).success).toBe(false);
		expect(mcpServerCreateSchema.safeParse({ name: 'a', transport: 'stdio' }).success).toBe(false);
		expect(
			mcpServerCreateSchema.safeParse({ name: 'a', transport: 'stdio', command: '  ' }).success
		).toBe(false);
		expect(
			mcpServerCreateSchema.safeParse({ name: 'a', transport: 'builtin', command: 'x' }).success
		).toBe(false);
		expect(
			mcpServerCreateSchema.safeParse({
				name: 'a',
				transport: 'stdio',
				command: 'x',
				args: [1, 2]
			}).success
		).toBe(false);
	});
});

describe('resolveMcpServerPatch', () => {
	it('passes non-connection patches through untouched', () => {
		expect(resolveMcpServerPatch(row(), { enabled: false, name: 'b' })).toEqual({
			ok: true,
			value: { enabled: false, name: 'b' }
		});
	});

	it('switching to stdio requires a command and clears url and token', () => {
		expect(resolveMcpServerPatch(row(), { transport: 'stdio' })).toEqual({
			ok: false,
			error: 'A stdio server requires a command'
		});
		expect(
			resolveMcpServerPatch(row(), { transport: 'stdio', command: 'node', args: ['srv.js'] })
		).toEqual({
			ok: true,
			value: {
				transport: 'stdio',
				command: 'node',
				args: ['srv.js'],
				url: null,
				token: null,
				auth: 'token',
				oauthClientId: null,
				oauthClientSecret: null,
				oauthScope: null
			}
		});
	});

	it('rejects OAuth for stdio servers', () => {
		const stdio = row({ transport: 'stdio', command: 'node', args: '[]', url: null });
		expect(resolveMcpServerPatch(stdio, { auth: 'oauth' })).toEqual({
			ok: false,
			error: 'OAuth needs an HTTP or SSE server'
		});
	});

	it('keeps stored args when only the command of a stdio server changes', () => {
		const stdio = row({ transport: 'stdio', command: 'node', args: '["a.js"]', url: null });
		const res = resolveMcpServerPatch(stdio, { command: 'bun' });
		expect(res.ok && res.value).toMatchObject({ command: 'bun', args: ['a.js'] });
	});

	it('switching a stdio server to http requires a url and clears the command', () => {
		const stdio = row({ transport: 'stdio', command: 'node', url: null, token_enc: null });
		expect(resolveMcpServerPatch(stdio, { transport: 'http' }).ok).toBe(false);
		expect(resolveMcpServerPatch(stdio, { transport: 'http', url: 'https://x.example' })).toEqual({
			ok: true,
			value: { transport: 'http', url: 'https://x.example', command: null, args: [] }
		});
	});

	it('ignores connection changes on builtin servers', () => {
		const builtin = row({ transport: 'builtin', builtin: 1, url: null });
		const patch = mcpServerPatchSchema.parse({ transport: 'stdio', command: 'sh', enabled: false });
		expect(resolveMcpServerPatch(builtin, patch)).toEqual({ ok: true, value: { enabled: false } });
	});
});
