/**
 * Private data: the one place that decides who may see it.
 *
 * Rule: data marked private only reaches model providers an admin trusts with
 * it (`allow_private`). A context holding private data is "tainted": its model
 * calls may only go to trusted providers. Tools are not restricted.
 *
 * Callers never decide this themselves: they pass a `Privacy` to the choke
 * points (`resolveModel`, `resolveImageModel`, `resolveAudioEndpoint`,
 * `forwardDecisions`), which call into this module.
 */
import type { ModelMappingTarget } from '$lib/types.js';
import type { Db } from '../db/index.js';

export type Trust = 'trusted' | 'untrusted';

/**
 * The privacy of the context a model or tool call runs in. Choke points OR
 * `tainted` with a fresh read of `conversations.private` / the run's agent, so
 * a job that started before a chat turned private is still stopped.
 */
export interface Privacy {
	/** Private data is already in this context (the turn read some, or it was started private). */
	tainted: boolean;
	conversationId?: string | null;
	agentRunId?: string | null;
	/** Why the context is tainted, for messages and logs. */
	reason?: string;
}

/**
 * For callers that never carry Chatty's private data: API-key routes (the
 * caller owns the payload; `trusted_only` mappings cover them) and probes
 * without content.
 */
export const NON_PRIVATE: Privacy = Object.freeze({ tainted: false });

/** A private context tried to reach something that may not see private data. */
export class PrivateDataBlockedError extends Error {
	readonly code = 'private_data_blocked';
	constructor(message = 'This private chat has no model that may process private data') {
		super(message);
		this.name = 'PrivateDataBlockedError';
	}
}

/**
 * The privacy of a tool call's context: the turn's own (which tracks taint)
 * or, without one, its conversation and run, which choke points re-read.
 */
export function callerPrivacy(ctx: {
	privacy?: Privacy;
	conversationId?: string | null;
	agentRunId?: string | null;
}): Privacy {
	return (
		ctx.privacy ?? {
			tainted: false,
			conversationId: ctx.conversationId ?? null,
			agentRunId: ctx.agentRunId ?? null
		}
	);
}

/**
 * Whether an admin allowed this provider to process private data. Unknown and
 * disabled providers aren't (as in hasTrustedProvider).
 */
export function providerTrust(db: Db, providerId: string): Trust {
	const row = db
		.prepare('SELECT allow_private, enabled FROM providers WHERE id = ?')
		.get(providerId) as { allow_private: number; enabled: number } | undefined;
	return row?.allow_private === 1 && row.enabled === 1 ? 'trusted' : 'untrusted';
}

/** Whether any enabled provider may process private data (the private toggles need one). */
export function hasTrustedProvider(db: Db): boolean {
	return (
		db.prepare('SELECT 1 FROM providers WHERE allow_private = 1 AND enabled = 1 LIMIT 1').get() !==
		undefined
	);
}

/** Whether the conversation is marked private. */
export function isConversationPrivate(db: Db, conversationId: string): boolean {
	const row = db.prepare('SELECT private FROM conversations WHERE id = ?').get(conversationId) as
		{ private: number } | undefined;
	return row?.private === 1;
}

/** Whether the run belongs to a private agent or runs in a private conversation. */
export function isAgentRunPrivate(db: Db, agentRunId: string): boolean {
	const row = db
		.prepare(
			`SELECT a.private AS agent_private, c.private AS conversation_private
			 FROM agent_runs r
			 LEFT JOIN agents a ON a.id = r.agent_id
			 LEFT JOIN conversations c ON c.id = r.conversation_id
			 WHERE r.id = ?`
		)
		.get(agentRunId) as
		{ agent_private: number | null; conversation_private: number | null } | undefined;
	return row?.agent_private === 1 || row?.conversation_private === 1;
}

/** Whether `p` holds private data, as of now (re-reads the DB flags). */
export function isPrivateContext(db: Db, p: Privacy): boolean {
	if (p.tainted) return true;
	if (p.conversationId && isConversationPrivate(db, p.conversationId)) return true;
	if (p.agentRunId && isAgentRunPrivate(db, p.agentRunId)) return true;
	return false;
}

/**
 * The targets a context may use: all of them for non-private data, only those
 * on trusted providers otherwise. Run before a fallback loop, so a retry can
 * never move private data to an untrusted provider.
 */
export function filterTargets<T extends { providerId: string }>(
	db: Db,
	targets: T[],
	p: Privacy
): T[] {
	if (!isPrivateContext(db, p)) return targets;
	return targets.filter((t) => providerTrust(db, t.providerId) === 'trusted');
}

/** Throws PrivateDataBlockedError when `p` is private and `ref`'s provider isn't trusted. */
export function assertModelAllowed(db: Db, ref: { providerId: string }, p: Privacy): void {
	if (!isPrivateContext(db, p)) return;
	if (providerTrust(db, ref.providerId) === 'trusted') return;
	throw new PrivateDataBlockedError();
}

/**
 * A turn is trusted only when every target it may still fall back to is on a
 * trusted provider; then its tools may return private items. Title and
 * compaction roles don't count (a private chat routes those separately).
 */
export function turnTrust(db: Db, targets: ModelMappingTarget[]): Trust {
	if (targets.length === 0) return 'untrusted';
	return targets.every((t) => providerTrust(db, t.providerId) === 'trusted')
		? 'trusted'
		: 'untrusted';
}
