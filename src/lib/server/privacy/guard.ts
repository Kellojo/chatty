/**
 * The tool-call check for private data. Runs in `wrapMcpTools` before every MCP
 * tool executes (builtin, external, and deferred tools loaded later), so a
 * tainted context can only run tools that keep data inside Chatty.
 */
import type { Db } from '../db/index.js';
import { getAgent } from '../db/repo/agents.js';
import { resolveRefTargets } from '../llm/mapped.js';
import { roleTrusted, toolEgress, type EgressClass, type EgressServer } from './egress.js';
import { isPrivateContext, PrivateDataBlockedError, turnTrust, type Privacy } from './policy.js';

/** Starts the message of a refused call; the chat shows such tool errors with a lock. */
export const BLOCKED_PREFIX = 'Blocked: this chat contains private data';

export function blockedMessage(toolName: string, cls: EgressClass): string {
	const why =
		cls === 'persist' ? 'stores data where it would not stay private' : 'sends data outside Chatty';
	return `${BLOCKED_PREFIX}, and \`${toolName}\` ${why}. Start a new, non-private chat for this.`;
}

/** Whether a model ref (a mapping too; null: the default chat model) only reaches trusted providers. */
export function modelRefTrusted(
	db: Db,
	providerId: string | null | undefined,
	modelId: string | null | undefined
): boolean {
	if (!providerId || !modelId) return roleTrusted(db, 'chat');
	try {
		return turnTrust(db, resolveRefTargets({ providerId, modelId }, db).targets) === 'trusted';
	} catch {
		return false;
	}
}

type Input = Record<string, unknown> | null | undefined;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * The agents tools are allowed from a tainted context when what they create or
 * start stays private: a private agent on a trusted model.
 */
function agentCallAllowed(db: Db, toolName: string, input: Input): boolean {
	if (toolName === 'create_agent') {
		return (
			input?.private === true && modelRefTrusted(db, str(input.providerId), str(input.modelId))
		);
	}
	const agentId = str(input?.agentId);
	const agent = agentId ? getAgent(db, agentId) : undefined;
	if (!agent) return false;
	if (toolName === 'start_agent') return agent.private === 1;
	if (toolName === 'update_agent') {
		const isPrivate = input?.private === undefined ? agent.private === 1 : input.private === true;
		const providerId = input?.providerId !== undefined ? str(input.providerId) : agent.provider_id;
		const modelId = input?.modelId !== undefined ? str(input.modelId) : agent.model_id;
		return isPrivate && modelRefTrusted(db, providerId, modelId);
	}
	return false;
}

/**
 * Throws PrivateDataBlockedError when `privacy` holds private data and the tool
 * isn't one that keeps it inside Chatty. Reads the flags fresh, so a call made
 * after the chat was promoted mid-turn is refused too.
 */
export function assertToolAllowed(
	db: Db,
	server: EgressServer,
	toolName: string,
	input: unknown,
	privacy: Privacy
): void {
	if (!isPrivateContext(db, privacy)) return;
	const cls = toolEgress(db, server, toolName);
	if (cls === 'none') return;
	if (
		server.builtin === 1 &&
		server.name === 'agents' &&
		agentCallAllowed(db, toolName, input as Input)
	) {
		return;
	}
	throw new PrivateDataBlockedError(blockedMessage(toolName, cls));
}

/** Whether to leave the tool out of a tainted turn's catalog (it would always be refused). */
export function hiddenWhenTainted(db: Db, server: EgressServer, toolName: string): boolean {
	if (server.builtin === 1 && server.name === 'agents') return false;
	return toolEgress(db, server, toolName) !== 'none';
}
