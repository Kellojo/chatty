import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallerContext } from '../types.js';
import { createWebfetchServer } from './webfetch.js';
import { createDatetimeServer } from './datetime.js';
import { createChatSearchServer } from './chat-search.js';
import { createFsServer } from './fs.js';
import { createMemoryServer } from './memory.js';
import { createAgentsServer } from './agents.js';
import { createSubagentsServer } from './subagents.js';
import { createCodingServer } from './coding.js';
import { createSkillsServer } from './skills.js';
import { createCodeExecServer } from './code-exec.js';
import { createImageServer } from './image.js';
import { createSpeechServer } from './speech.js';
import { createMathServer } from './math.js';
import { createWeatherServer } from './weather.js';

export type BuiltinServerFactory = (ctx: CallerContext) => McpServer;

export const BUILTIN_SERVERS: Record<string, BuiltinServerFactory> = {
	webfetch: createWebfetchServer,
	datetime: createDatetimeServer,
	'chat-search': createChatSearchServer,
	fs: createFsServer,
	memory: createMemoryServer,
	agents: createAgentsServer,
	subagents: createSubagentsServer,
	coding: createCodingServer,
	skills: createSkillsServer,
	'code-exec': createCodeExecServer,
	image: createImageServer,
	speech: createSpeechServer,
	math: createMathServer,
	weather: createWeatherServer
};
