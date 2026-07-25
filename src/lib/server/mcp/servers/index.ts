import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallerContext } from '../types.js';
import { createWebfetchServer } from './webfetch.js';
import { createWebsearchServer } from './websearch.js';
import { createDatetimeServer } from './datetime.js';
import { createChatSearchServer } from './chat-search.js';
import { createFsServer } from './fs.js';
import { createSettingsServer } from './settings.js';
import { createMemoryServer } from './memory.js';
import { createAgentsServer } from './agents.js';
import { createSkillsServer } from './skills.js';
import { createCodeExecServer } from './code-exec.js';

export type BuiltinServerFactory = (ctx: CallerContext) => McpServer;

export const BUILTIN_SERVERS: Record<string, BuiltinServerFactory> = {
	webfetch: createWebfetchServer,
	websearch: createWebsearchServer,
	datetime: createDatetimeServer,
	'chat-search': createChatSearchServer,
	fs: createFsServer,
	settings: createSettingsServer,
	memory: createMemoryServer,
	agents: createAgentsServer,
	skills: createSkillsServer,
	'code-exec': createCodeExecServer
};
