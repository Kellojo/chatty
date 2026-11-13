// Converts an API key's MCP gateway access (per server: all tools, or a list)
// to and from the flat list of tool names the tool picker edits.

import type { McpGatewayServer, McpKeyAccess, ToolInfo } from '$lib/types.js';

/** The access a key has when none was saved: the default servers, all tools. */
export function defaultAccess(servers: McpGatewayServer[]): McpKeyAccess {
	return servers.filter((s) => s.exposedByDefault).map((s) => ({ serverId: s.id, tools: null }));
}

/** The tool names `access` allows among the tools listed now. */
export function accessToToolNames(
	access: McpKeyAccess,
	servers: McpGatewayServer[],
	tools: ToolInfo[]
): string[] {
	const nameToId = new Map(servers.map((s) => [s.name, s.id]));
	const entries = new Map(access.map((e) => [e.serverId, e.tools]));
	return tools
		.filter((tool) => {
			const id = nameToId.get(tool.server);
			if (!id || !entries.has(id)) return false;
			const allowed = entries.get(id);
			return allowed === null || allowed?.includes(tool.name) === true;
		})
		.map((t) => t.name);
}

/**
 * The access for a picked set of tool names. A server whose every tool is
 * picked gets all of them, including ones it adds later. Servers that listed
 * no tools now (unreachable, or not signed in) keep what `previous` gave them.
 */
export function toolNamesToAccess(
	selected: string[],
	previous: McpKeyAccess,
	servers: McpGatewayServer[],
	tools: ToolInfo[]
): McpKeyAccess {
	const picked = new Set(selected);
	const byServer = new Map<string, ToolInfo[]>();
	for (const tool of tools) byServer.set(tool.server, [...(byServer.get(tool.server) ?? []), tool]);
	const access: McpKeyAccess = [];
	for (const server of servers) {
		const listed = byServer.get(server.name);
		if (!listed) {
			const kept = previous.find((e) => e.serverId === server.id);
			if (kept) access.push(kept);
			continue;
		}
		const on = listed.filter((t) => picked.has(t.name)).map((t) => t.name);
		if (on.length === 0) continue;
		access.push({ serverId: server.id, tools: on.length === listed.length ? null : on });
	}
	return access;
}

/** "memory, skills (2 tools) +3": a short line naming what a key may use. */
export function describeAccess(access: McpKeyAccess, servers: McpGatewayServer[]): string {
	const byId = new Map(servers.map((s) => [s.id, s]));
	const parts = access.flatMap((e) => {
		const server = byId.get(e.serverId);
		if (!server) return [];
		return [
			e.tools === null
				? server.name
				: `${server.name} (${e.tools.length} ${e.tools.length === 1 ? 'tool' : 'tools'})`
		];
	});
	if (parts.length === 0) return 'No servers';
	const shown = parts.slice(0, 4).join(', ');
	return parts.length > 4 ? `${shown} +${parts.length - 4}` : shown;
}
