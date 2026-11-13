import { describe, expect, it } from 'vitest';
import {
	accessToToolNames,
	defaultAccess,
	describeAccess,
	toolNamesToAccess
} from './mcp-access.js';
import type { McpGatewayServer, ToolInfo } from './types.js';

const server = (id: string, exposedByDefault = true): McpGatewayServer => ({
	id,
	name: `${id}-name`,
	builtin: true,
	transport: 'builtin',
	toolCount: null,
	exposedByDefault,
	needsSignIn: false
});
const servers = [server('memory'), server('fs', false), server('remote')];
const tool = (name: string, s: string): ToolInfo => ({
	name,
	description: '',
	server: `${s}-name`
});
// "remote" lists no tools now (unreachable).
const tools = [tool('search', 'memory'), tool('write', 'memory'), tool('read_file', 'fs')];

describe('mcp-access', () => {
	it('defaults to the servers marked default, all tools', () => {
		expect(defaultAccess(servers)).toEqual([
			{ serverId: 'memory', tools: null },
			{ serverId: 'remote', tools: null }
		]);
		expect(accessToToolNames(defaultAccess(servers), servers, tools)).toEqual(['search', 'write']);
	});

	it('round-trips picks: whole servers become null, partial ones a list', () => {
		const previous = [{ serverId: 'remote', tools: ['x'] }];
		expect(toolNamesToAccess(['search', 'write'], previous, servers, tools)).toEqual([
			{ serverId: 'memory', tools: null },
			// Not listed now, so what it had is kept.
			{ serverId: 'remote', tools: ['x'] }
		]);
		expect(toolNamesToAccess(['write', 'read_file'], [], servers, tools)).toEqual([
			{ serverId: 'memory', tools: ['write'] },
			{ serverId: 'fs', tools: null }
		]);
		expect(accessToToolNames([{ serverId: 'memory', tools: ['write'] }], servers, tools)).toEqual([
			'write'
		]);
	});

	it('describes access briefly', () => {
		expect(
			describeAccess(
				[
					{ serverId: 'memory', tools: null },
					{ serverId: 'fs', tools: ['read_file'] },
					{ serverId: 'gone', tools: null }
				],
				servers
			)
		).toBe('memory-name, fs-name (1 tool)');
		expect(describeAccess([], servers)).toBe('No servers');
	});
});
