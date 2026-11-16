/**
 * What each builtin tool does with data, for tainted contexts:
 * - `none`: pure, or only reads and writes stores that handle the private flag;
 * - `egress`: sends data out of Chatty (the internet, another app, an untrusted model);
 * - `persist`: writes to a store that isn't private-aware (it would outlive the chat).
 *
 * A tainted context may only run `none` tools. Keyed by `server/tool`; a test
 * fails when a builtin tool is missing, so a new tool can't skip the check.
 * Unknown tools are `egress` (fail closed).
 */
import type { Db } from '../db/index.js';
import { findRoleModel, type ModelRole } from '../db/repo/models.js';
import { resolveRefTargets } from '../llm/mapped.js';
import { turnTrust } from './policy.js';

export type EgressClass = 'none' | 'egress' | 'persist';

export const TOOL_EGRESS: Readonly<Record<string, EgressClass>> = {
	'webfetch/fetch': 'egress',
	'websearch/web_search': 'egress',
	'websearch/search_places': 'egress',
	'weather/get_weather': 'egress',

	'datetime/now': 'none',
	'datetime/convert': 'none',
	'datetime/wait': 'none',

	'math/calculate': 'none',
	'math/statistics': 'none',
	'math/convert_units': 'none',
	'math/list_units': 'none',

	// Taint sources: filtered for untrusted turns, taint trusted ones.
	'chat-search/search_chats': 'none',
	'chat-search/read_chat': 'none',
	'memory/search_memory': 'none',
	'memory/read_concept': 'none',
	'memory/list_concepts': 'none',
	// Private-aware: a tainted context's writes are forced private, and private
	// concepts don't exist for untrusted turns (mcp/servers/memory.ts).
	'memory/create_concept': 'none',
	'memory/update_concept': 'none',
	'memory/delete_concept': 'none',

	// Workspaces are private through their conversation; `documents/` writes are
	// redirected to `documents/private/` from a tainted context.
	'fs/fs_ls': 'none',
	'fs/fs_read': 'none',
	'fs/fs_grep': 'none',
	'fs/fs_glob': 'none',
	'fs/fs_write': 'none',
	'fs/fs_edit': 'none',
	'fs/fs_mkdir': 'none',
	'fs/fs_rm': 'none',
	'fs/fs_curl': 'egress',

	// isolated-vm without network; reaches only the conversation's workspace.
	'code-exec/code_exec': 'none',

	'agents/list_agents': 'none',
	'agents/get_agent': 'none',
	'agents/get_agent_run': 'none',
	'agents/delete_agent': 'none',
	// Allowed only for a private agent on a trusted model (checked on the arguments).
	'agents/create_agent': 'persist',
	'agents/update_agent': 'persist',
	// Allowed only on private agents (checked on the arguments).
	'agents/start_agent': 'egress',

	// The subagent inherits the parent's privacy, its report taints the parent.
	'subagents/run_subagent': 'none',

	'coding/list_coding_projects': 'none',
	'coding/propose_coding_task': 'egress',

	'skills/load_skill': 'none',
	'skills/read_skill_reference': 'none',
	// Skill names and descriptions go into every prompt.
	'skills/create_skill': 'persist',
	'skills/update_skill': 'persist',
	'skills/delete_skill': 'persist',

	// Egress unless the role's provider is trusted (see ROLE_TOOLS).
	'image/generate_image': 'egress',
	'image/edit_image': 'egress',
	'speech/transcribe_audio': 'egress'
};

/** Tools that only send data to a role model: `none` when that role's provider is trusted. */
const ROLE_TOOLS: Readonly<Record<string, ModelRole>> = {
	'image/generate_image': 'image',
	'image/edit_image': 'image',
	'speech/transcribe_audio': 'speech-to-text'
};

/** The server an MCP tool comes from, as far as the egress check needs it. */
export interface EgressServer {
	name: string;
	/** 1 for Chatty's bundled servers, which are classified in code. */
	builtin: number;
	/** 1 when an admin allowed this (external) server in private chats. */
	allow_private?: number;
}

/** Whether every target of the role's model is on a trusted provider (false when unset). */
export function roleTrusted(db: Db, role: ModelRole): boolean {
	const model = findRoleModel(db, role);
	if (!model) return false;
	try {
		const { targets } = resolveRefTargets(
			{ providerId: model.provider_id, modelId: model.model_id },
			db
		);
		return turnTrust(db, targets) === 'trusted';
	} catch {
		return false;
	}
}

/** How `toolName` on `server` treats data (see TOOL_EGRESS). */
export function toolEgress(db: Db, server: EgressServer, toolName: string): EgressClass {
	if (server.builtin !== 1) return server.allow_private === 1 ? 'none' : 'egress';
	const key = `${server.name}/${toolName}`;
	const role = ROLE_TOOLS[key];
	if (role && roleTrusted(db, role)) return 'none';
	return TOOL_EGRESS[key] ?? 'egress';
}
