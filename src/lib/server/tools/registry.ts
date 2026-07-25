import path from 'node:path';
import type { Tool } from 'ai';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { listEnabledMcpServers } from '../db/repo/mcp-servers.js';
import { createLogger } from '../logger.js';
import { connectServer } from '../mcp/clientManager.js';
import type { CallerContext } from '../mcp/types.js';
import { wrapMcpTools } from './wrap.js';

const log = createLogger('tools');

export interface BuildToolsInput {
	userId: string;
	memoryEnabled: boolean;
	workspaceDir?: string | null;
	agentAllowlist?: string[];
	author?: string;
	conversationId?: string | null;
	agentRunId?: string | null;
}

export interface BuiltTools {
	tools: Record<string, Tool>;
	toolToServer: Record<string, string>;
	close: () => Promise<void>;
}

export async function buildTools(input: BuildToolsInput): Promise<BuiltTools> {
	const db = getDb();
	const user = db.prepare('SELECT role FROM "user" WHERE id = ?').get(input.userId) as
		{ role: string } | undefined;
	const ctx: CallerContext = {
		userId: input.userId,
		role: user?.role ?? 'user',
		workspaceDir: input.workspaceDir ?? null,
		documentsDir: path.join(path.resolve(config.DOCUMENTS_VOLUME), input.userId),
		author: input.author,
		conversationId: input.conversationId,
		agentRunId: input.agentRunId
	};
	const rows = listEnabledMcpServers(db).filter(
		(row) => input.memoryEnabled || row.name !== 'memory'
	);
	const tools: Record<string, Tool> = {};
	const toolToServer: Record<string, string> = {};
	const closers: Array<() => Promise<void>> = [];
	const results = await Promise.allSettled(
		rows.map((row) => connectServer(row, ctx))
	);
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const result = results[i];
		if (result.status === 'fulfilled') {
			try {
				closers.push(result.value.close);
				const set = wrapMcpTools(
					(await result.value.client.tools()) as unknown as Record<string, Tool>,
					row.name
				);
				for (const [name, tool] of Object.entries(set)) {
					if (tools[name]) {
						log.warn(`MCP tool name collision: "${name}" from ${row.name} skipped`);
						continue;
					}
					tools[name] = tool;
					toolToServer[name] = row.name;
				}
			} catch (e) {
				log.warn(`MCP server ${row.name} unavailable:`, {
					error: e instanceof Error ? e.message : String(e)
				});
			}
		} else {
			log.warn(`MCP server ${row.name} unavailable:`, {
				error: result.reason instanceof Error ? result.reason.message : String(result.reason)
			});
		}
	}
	let filtered = tools;
	if (input.agentAllowlist) {
		filtered = {};
		for (const name of input.agentAllowlist) {
			if (tools[name]) filtered[name] = tools[name];
		}
	}
	return {
		tools: filtered,
		toolToServer,
		close: async () => {
			for (const closer of closers.reverse()) {
				await closer().catch(() => undefined);
			}
		}
	};
}
