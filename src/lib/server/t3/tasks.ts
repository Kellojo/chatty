// Coding tasks: chat conversations whose replies come from a coding agent on a
// connected T3 Code server. This module holds the request-facing operations;
// the long-lived mirroring lives in ./follower.ts.

import { randomUUID } from 'node:crypto';
import type { UIMessage } from 'ai';
import type {
	CodingAutonomy,
	CodingModelOption,
	CodingProjectOption,
	CodingWorkspaceMode
} from '$lib/coding-environments.js';
import { repositoryName, type CodingModelRef } from '$lib/coding-environments.js';
import { createStreamReplayResponse } from '../chat/replay.js';
import { decryptSecret } from '../crypto.js';
import { getDb, type Db } from '../db/index.js';
import {
	createCodingConversation,
	getCodingConversation,
	listLiveCodingConversations,
	updateCodingConversation,
	type CodingConversationRow
} from '../db/repo/coding-conversations.js';
import { getCodingEnvironment, type CodingEnvironmentRow } from '../db/repo/coding-environments.js';
import { createConversation, getConversation } from '../db/repo/conversations.js';
import { createMessage, extractText } from '../db/repo/messages.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { connectT3, t3HttpGet, T3ClientError, type T3Connection } from './client.js';
import { ensureFollower, getFollower } from './follower.js';
import {
	parseFavorites,
	parseModelSelection,
	parseModels,
	resolveDefaultModel
} from './options.js';

const log = createLogger('t3-tasks');

export class CodingTaskError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'CodingTaskError';
	}
}

/** Maps Chatty's autonomy choice to T3's runtime mode. */
export const RUNTIME_MODES: Record<CodingAutonomy, string> = {
	supervised: 'approval-required',
	'auto-edits': 'auto-accept-edits',
	auto: 'auto',
	'full-access': 'full-access'
};

function autonomyFromRuntimeMode(mode: unknown): CodingAutonomy | null {
	const entry = Object.entries(RUNTIME_MODES).find(([, runtime]) => runtime === mode);
	return entry ? (entry[0] as CodingAutonomy) : null;
}

const workspaceModeFromEnvMode = (mode: unknown): CodingWorkspaceMode | null =>
	mode === 'local' ? 'local' : mode === 'worktree' ? 'worktree' : null;

function asTaskError(e: unknown, fallback: string): CodingTaskError {
	if (e instanceof CodingTaskError) return e;
	if (e instanceof T3ClientError) {
		return new CodingTaskError(e.kind === 'unauthorized' ? 403 : 502, e.message);
	}
	log.error(fallback, { error: e instanceof Error ? e.message : String(e) });
	return new CodingTaskError(500, fallback);
}

function requireEnvironment(db: Db, userId: string, environmentId: string): CodingEnvironmentRow {
	const env = getCodingEnvironment(db, userId, environmentId);
	if (!env) throw new CodingTaskError(404, 'Coding environment not found');
	if (env.enabled !== 1) throw new CodingTaskError(409, 'This coding environment is disabled');
	return env;
}

async function withConnection<T>(
	env: CodingEnvironmentRow,
	fn: (conn: T3Connection) => Promise<T>
): Promise<T> {
	const conn = await connectT3(env.base_url, decryptSecret(env.token_enc));
	try {
		return await fn(conn);
	} finally {
		conn.close();
	}
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

interface RemoteProject {
	id: string;
	title: string;
	workspaceRoot: string | null;
	isGitRepo: boolean;
	defaultModel: CodingModelRef | null;
	defaultWorkspaceMode: CodingWorkspaceMode | null;
}

async function listRemoteProjects(env: CodingEnvironmentRow): Promise<RemoteProject[]> {
	const body = rec(await t3HttpGet(env.base_url, decryptSecret(env.token_enc), '/api/projects'));
	const projects = Array.isArray(body?.projects) ? body.projects : [];
	return projects
		.map(rec)
		.filter((p): p is Rec => p !== null && !!str(p.id) && !p.deletedAt && !p.archivedAt)
		.map((p) => ({
			id: String(p.id),
			title: str(p.title) ?? String(p.id),
			workspaceRoot: str(p.workspaceRoot),
			isGitRepo: rec(p.repositoryIdentity) !== null,
			defaultModel: parseModelSelection(p.defaultModelSelection),
			defaultWorkspaceMode: workspaceModeFromEnvMode(p.defaultThreadEnvMode)
		}))
		.sort((a, b) => a.title.localeCompare(b.title));
}

export async function getCodingOptions(
	userId: string,
	environmentId: string,
	db: Db = getDb()
): Promise<{
	projects: CodingProjectOption[];
	models: CodingModelOption[];
	defaultModel: CodingModelRef | null;
	defaultAutonomy: CodingAutonomy | null;
	defaultWorkspaceMode: CodingWorkspaceMode | null;
}> {
	const env = requireEnvironment(db, userId, environmentId);
	try {
		const [projects, config] = await Promise.all([
			listRemoteProjects(env),
			withConnection(env, (conn) => conn.call('server.getConfig', {}))
		]);
		// T3 resolves a new thread's defaults as: project override, then the
		// project's own setting, then the user's server-wide settings. Mirror
		// that so Chatty starts the same way.
		const settings = rec(rec(config)?.settings);
		const models = parseModels(config, parseFavorites(settings));
		const overrides = rec(settings?.projectSettingsOverrides);
		const override = (projectId: string) => rec(overrides?.[projectId]);
		const serverDefault = parseModelSelection(settings?.defaultModelSelection);
		return {
			projects: projects.map((p) => ({
				id: p.id,
				title: p.title,
				defaultBranch: null,
				isGitRepo: p.isGitRepo,
				defaultModel: resolveDefaultModel(
					[
						parseModelSelection(override(p.id)?.defaultModelSelection),
						p.defaultModel,
						serverDefault
					],
					models
				),
				defaultAutonomy: autonomyFromRuntimeMode(override(p.id)?.defaultRuntimeMode),
				defaultWorkspaceMode:
					workspaceModeFromEnvMode(override(p.id)?.defaultThreadEnvMode) ?? p.defaultWorkspaceMode
			})),
			models,
			defaultModel: resolveDefaultModel([serverDefault], models),
			defaultAutonomy: autonomyFromRuntimeMode(settings?.defaultRuntimeMode),
			defaultWorkspaceMode: workspaceModeFromEnvMode(settings?.defaultThreadEnvMode)
		};
	} catch (e) {
		throw asTaskError(e, 'Could not load options from the coding environment');
	}
}

export async function getProjectBranches(
	userId: string,
	environmentId: string,
	projectId: string,
	db: Db = getDb()
): Promise<{
	isRepo: boolean;
	branches: { name: string; isDefault: boolean; current: boolean }[];
}> {
	const env = requireEnvironment(db, userId, environmentId);
	try {
		const project = (await listRemoteProjects(env)).find((p) => p.id === projectId);
		if (!project) throw new CodingTaskError(404, 'Project not found on this environment');
		if (!project.workspaceRoot) return { isRepo: false, branches: [] };
		const result = rec(
			await withConnection(env, (conn) =>
				conn.call('vcs.listRefs', { cwd: project.workspaceRoot, refKind: 'local', limit: 50 })
			)
		);
		const refs = Array.isArray(result?.refs) ? result.refs : [];
		return {
			isRepo: result?.isRepo === true,
			branches: refs
				.map(rec)
				.filter((r): r is Rec => r !== null && !!str(r.name) && r.isRemote !== true)
				.map((r) => ({
					name: String(r.name),
					isDefault: r.isDefault === true,
					current: r.current === true
				}))
		};
	} catch (e) {
		throw asTaskError(e, 'Could not load branches from the coding environment');
	}
}

const CLONE_TIMEOUT_MS = 10 * 60_000;

/** `owner/repo` (GitHub shorthand) rather than a full clone URL. */
const isRepoShorthand = (source: string) => /^[\w.-]+\/[\w.-]+$/.test(source);

export interface CreateCodingProjectInput {
	environmentId: string;
	title: string;
	/** Clone source (`owner/repo` or a git URL). Omitted: a new, empty project. */
	repository?: string;
}

/**
 * Creates a project on the environment: a fresh git repository named after
 * `title`, or a clone of `repository` into the user's T3 project folder.
 */
export async function createCodingProject(
	userId: string,
	input: CreateCodingProjectInput,
	db: Db = getDb()
): Promise<{ project: { id: string; title: string }; warning: string | null }> {
	const env = requireEnvironment(db, userId, input.environmentId);
	try {
		if (!input.repository) {
			const result = rec(
				await withConnection(env, (conn) => conn.call('projects.createNew', { name: input.title }))
			);
			const projectId = str(result?.projectId);
			if (!projectId) throw new CodingTaskError(502, 'The environment did not return a project');
			const commitError = str(result?.commitError);
			return {
				project: { id: projectId, title: input.title },
				warning: commitError ? `Project created, but the first commit failed: ${commitError}` : null
			};
		}

		const source = input.repository.trim();
		const folder = repositoryName(source);
		if (!folder) throw new CodingTaskError(400, 'Enter a repository as owner/repo or a git URL');
		return await withConnection(env, async (conn) => {
			const config = rec(await conn.call('server.getConfig', {}));
			// Same destination T3's own "clone" dialog proposes.
			const base = str(rec(config?.settings)?.addProjectBaseDirectory) ?? '~';
			const destinationPath = `${base.replace(/[\\/]+$/, '')}/${folder}`;
			const cloned = rec(
				await conn.call(
					'sourceControl.cloneRepository',
					{
						destinationPath,
						protocol: 'auto',
						...(isRepoShorthand(source)
							? { provider: 'github', repository: source }
							: { remoteUrl: source })
					},
					CLONE_TIMEOUT_MS
				)
			);
			const cwd = str(cloned?.cwd);
			if (!cwd) throw new CodingTaskError(502, 'The environment did not report the clone location');
			const projectId = randomUUID();
			await conn.call('projects.mutate', {
				type: 'project.create',
				commandId: randomUUID(),
				projectId,
				title: input.title,
				workspaceRoot: cwd
			});
			return { project: { id: projectId, title: input.title }, warning: null };
		});
	} catch (e) {
		if (e instanceof T3ClientError && e.kind === 'unauthorized' && input.repository) {
			throw new CodingTaskError(
				403,
				'This environment was paired without permission to clone. Re-pair it in Settings → Environments, then try again.'
			);
		}
		throw asTaskError(e, 'Could not create the project');
	}
}

export interface CreateCodingTaskInput {
	environmentId: string;
	projectId: string;
	providerInstanceId: string;
	model: string;
	autonomy: CodingAutonomy;
	workspaceMode: CodingWorkspaceMode;
	baseBranch?: string | null;
}

/**
 * Checks a coding target against the user's environments and the remote
 * project list. Used before creating a task and when saving a coding agent.
 */
export async function resolveCodingTarget(
	userId: string,
	input: Pick<CreateCodingTaskInput, 'environmentId' | 'projectId' | 'workspaceMode'>,
	db: Db = getDb()
): Promise<{ env: CodingEnvironmentRow; project: RemoteProject }> {
	const env = requireEnvironment(db, userId, input.environmentId);
	let project: RemoteProject | undefined;
	try {
		project = (await listRemoteProjects(env)).find((p) => p.id === input.projectId);
	} catch (e) {
		throw asTaskError(e, 'Could not reach the coding environment');
	}
	if (!project) throw new CodingTaskError(404, 'Project not found on this environment');
	if (input.workspaceMode === 'worktree' && !project.isGitRepo) {
		throw new CodingTaskError(400, 'Worktrees need a git repository; use the project checkout');
	}
	return { env, project };
}

/**
 * Creates the conversation + task record. Nothing runs remotely yet: the task
 * starts with the first message sent through the normal chat flow (or
 * `launchCodingTask`).
 */
export async function createCodingTask(
	userId: string,
	input: CreateCodingTaskInput,
	db: Db = getDb(),
	opts: {
		title?: string;
		/** Runs before `chat.created` is published (e.g. to link an agent run first). */
		onCreated?: (conversationId: string) => void;
	} = {}
) {
	const { env, project } = await resolveCodingTarget(userId, input, db);

	const conversation = db.transaction(() => {
		const conv = createConversation(db, userId, {
			kind: 'chat',
			mode: 'agent',
			title: opts.title?.trim().slice(0, 200) ?? ''
		});
		createCodingConversation(db, {
			conversationId: conv.id,
			environmentId: env.id,
			projectId: project.id,
			projectTitle: project.title,
			providerInstanceId: input.providerInstanceId,
			model: input.model,
			runtimeMode: RUNTIME_MODES[input.autonomy],
			workspaceMode: input.workspaceMode,
			baseBranch: input.workspaceMode === 'worktree' ? (input.baseBranch ?? null) : null
		});
		opts.onCreated?.(conv.id);
		return conv;
	})();
	publishServerEvent(userId, { type: 'chat.created', conversationId: conversation.id });
	return { conversation, coding: getCodingConversation(db, conversation.id)! };
}

/** Longest first message a launch accepts (hand-offs, agent prompts). */
export const MAX_LAUNCH_PROMPT = 20_000;

/** A conversation title from the start of a prompt. */
function titleFromPrompt(text: string): string {
	const raw = text.trim().replace(/\s+/g, ' ');
	if (raw.length <= 50) return raw;
	const cut = raw.lastIndexOf(' ', 50);
	return (cut > 10 ? raw.slice(0, cut) : raw.slice(0, 50)) + '…';
}

/**
 * Creates a coding task and sends `prompt` as its first message, so the remote
 * agent starts right away. The task stays (with its error) when launching fails.
 */
export async function launchCodingTask(
	userId: string,
	input: CreateCodingTaskInput & { prompt: string; title?: string },
	db: Db = getDb(),
	opts: { onCreated?: (conversationId: string) => void } = {}
) {
	const prompt = input.prompt.trim();
	if (!prompt) throw new CodingTaskError(400, 'Message is empty');
	if (prompt.length > MAX_LAUNCH_PROMPT) throw new CodingTaskError(400, 'Message is too long');
	const created = await createCodingTask(userId, input, db, {
		title: input.title || titleFromPrompt(prompt),
		onCreated: opts.onCreated
	});
	const messageId = randomUUID();
	createMessage(db, {
		id: messageId,
		conversationId: created.conversation.id,
		role: 'user',
		parts: [{ type: 'text', text: prompt }],
		status: 'complete'
	});
	await sendCodingTurn(userId, created.coding, { id: messageId, text: prompt }, db);
	return {
		conversation: created.conversation,
		coding: getCodingConversation(db, created.conversation.id)!
	};
}

/**
 * Sends a user message to the task's thread (launching it on the first
 * message) and returns the streaming response for the reply.
 */
export async function startCodingTurn(
	userId: string,
	coding: CodingConversationRow,
	message: UIMessage,
	db: Db = getDb()
): Promise<Response> {
	const text = extractText(message.parts).trim();
	if (!text) throw new CodingTaskError(400, 'Message is empty');
	if (message.parts.some((p) => p.type === 'file')) {
		throw new CodingTaskError(400, 'Attachments are not supported for coding tasks yet');
	}
	await sendCodingTurn(userId, coding, { id: message.id, text }, db);
	return createStreamReplayResponse(coding.conversation_id) ?? new Response(null, { status: 204 });
}

/** Tail of each conversation's chain of turns being sent (see `sendCodingTurn`). */
const turnChains = new Map<string, Promise<void>>();

/**
 * Runs `fn` after every earlier call for the same conversation has settled, so
 * two messages sent at once can't both launch a thread.
 */
async function serializedByConversation<T>(
	conversationId: string,
	fn: () => Promise<T>
): Promise<T> {
	const previous = turnChains.get(conversationId) ?? Promise.resolve();
	const result = previous.then(fn);
	const tail = result.then(
		() => undefined,
		() => undefined
	);
	turnChains.set(conversationId, tail);
	try {
		return await result;
	} finally {
		if (turnChains.get(conversationId) === tail) turnChains.delete(conversationId);
	}
}

/** Launches the thread on the first message, otherwise sends a follow-up. */
function sendCodingTurn(
	userId: string,
	coding: CodingConversationRow,
	message: { id: string; text: string },
	db: Db
): Promise<void> {
	return serializedByConversation(coding.conversation_id, () =>
		// Re-read: a turn sent just before may have launched the thread.
		sendCodingTurnNow(
			userId,
			getCodingConversation(db, coding.conversation_id) ?? coding,
			message,
			db
		)
	);
}

async function sendCodingTurnNow(
	userId: string,
	coding: CodingConversationRow,
	message: { id: string; text: string },
	db: Db
): Promise<void> {
	if (!coding.environment_id) {
		throw new CodingTaskError(409, 'The coding environment for this task was removed');
	}
	const env = requireEnvironment(db, userId, coding.environment_id);
	const { text } = message;

	const threadId = coding.thread_id ?? randomUUID();
	const follower = ensureFollower({
		conversationId: coding.conversation_id,
		userId,
		env,
		threadId
	});
	follower.beginTurn(message.id);
	try {
		if (!coding.thread_id) {
			updateCodingConversation(db, coding.conversation_id, {
				threadId,
				status: 'starting',
				lastError: null
			});
			const conversation = getConversation(db, userId, coding.conversation_id);
			await follower.launch({
				threadId,
				projectId: coding.project_id,
				title: conversation?.title || text.slice(0, 60),
				modelSelection: { instanceId: coding.provider_instance_id, model: coding.model },
				runtimeMode: coding.runtime_mode,
				workspaceStrategy:
					coding.workspace_mode === 'worktree'
						? { type: 'worktree', baseRef: coding.base_branch ?? 'main' }
						: { type: 'root' },
				message: { id: message.id, text }
			});
		} else {
			await follower.sendMessage({ id: message.id, text });
		}
	} catch (e) {
		follower.failTurn();
		const error = asTaskError(e, 'Could not start the coding agent');
		updateCodingConversation(db, coding.conversation_id, {
			lastError: error.message,
			...(coding.thread_id ? {} : { status: 'failed' as const })
		});
		publishServerEvent(userId, {
			type: 'coding.task.updated',
			conversationId: coding.conversation_id
		});
		throw error;
	}
	void follower.follow();
}

/**
 * Last request answered (or being answered) per conversation. One entry per
 * conversation; a new pending request has a new id, so it never blocks one.
 */
const respondedRequests = new Map<string, string>();

export async function respondToCodingRequest(
	userId: string,
	conversationId: string,
	input: { requestId: string; optionId?: string; text?: string },
	db: Db = getDb()
): Promise<void> {
	const conversation = getConversation(db, userId, conversationId);
	const coding = conversation ? getCodingConversation(db, conversationId) : undefined;
	if (!coding) throw new CodingTaskError(404, 'Coding task not found');
	const pending = coding.pending_request
		? (JSON.parse(
				coding.pending_request
			) as import('$lib/coding-environments.js').CodingPendingRequest)
		: null;
	if (!pending || pending.requestId !== input.requestId) {
		throw new CodingTaskError(409, 'This request was already answered or has expired');
	}
	if (!coding.environment_id) {
		throw new CodingTaskError(409, 'The coding environment for this task was removed');
	}
	const env = requireEnvironment(db, userId, coding.environment_id);
	// A double click must not answer the same request twice: the stored
	// request only clears once T3 reports it resolved.
	if (respondedRequests.get(conversationId) === pending.requestId) {
		throw new CodingTaskError(409, 'This request was already answered or has expired');
	}
	respondedRequests.set(conversationId, pending.requestId);
	const follower = ensureFollower({
		conversationId,
		userId,
		env,
		threadId: coding.thread_id
	});
	const text = input.text?.trim() || undefined;
	try {
		if (pending.kind === 'approval') {
			if (!input.optionId || !pending.options.some((o) => o.id === input.optionId)) {
				throw new CodingTaskError(400, 'Choose one of the offered options');
			}
			await follower.respond({
				requestId: pending.requestId,
				decision: input.optionId,
				feedback: text
			});
		} else {
			const option = pending.options.find((o) => o.id === input.optionId);
			const answer = text ?? option?.label;
			if (!answer) throw new CodingTaskError(400, 'Choose an option or type an answer');
			await follower.respond({
				requestId: pending.requestId,
				answers: { [pending.questionId ?? 'answer']: answer }
			});
		}
	} catch (e) {
		// Not sent: let the user try again.
		if (respondedRequests.get(conversationId) === pending.requestId) {
			respondedRequests.delete(conversationId);
		}
		throw asTaskError(e, 'Could not send the answer to the coding agent');
	}
	void follower.follow();
}

/**
 * Interrupts the run active on a task's thread straight on T3, for when no
 * follower here streams it (e.g. it gave up, or the server restarted).
 * Best-effort: failures are logged, never thrown.
 */
export async function interruptCodingTaskRemotely(
	userId: string,
	conversationId: string,
	db: Db = getDb()
): Promise<void> {
	try {
		const coding = getCodingConversation(db, conversationId);
		if (!coding?.thread_id || !coding.environment_id) return;
		const env = getCodingEnvironment(db, userId, coding.environment_id);
		if (!env || env.enabled !== 1) return;
		const shell = rec(
			await t3HttpGet(
				env.base_url,
				decryptSecret(env.token_enc),
				'/api/orchestration/shell?omitIdleSubagents=1'
			)
		);
		const thread = (Array.isArray(shell?.threads) ? shell.threads : [])
			.map(rec)
			.find((t) => t?.id === coding.thread_id);
		const runId = thread?.activeRunId;
		if (typeof runId !== 'string' || !runId) return;
		await withConnection(env, (conn) =>
			conn.call('orchestration.dispatchCommand', {
				type: 'run.interrupt',
				commandId: randomUUID(),
				threadId: coding.thread_id,
				runId,
				holdQueue: true
			})
		);
	} catch (e) {
		log.warn('Could not interrupt the coding agent', {
			conversationId,
			error: e instanceof Error ? e.message : String(e)
		});
	}
}

/** Re-attaches to tasks that were still working when the server stopped. */
export function resumeCodingTasks(db: Db = getDb()): void {
	for (const row of listLiveCodingConversations(db)) {
		if (!row.environment_id) continue;
		const env = getCodingEnvironment(db, row.user_id, row.environment_id);
		if (!env || env.enabled !== 1) continue;
		if (getFollower(row.conversation_id)) continue;
		void ensureFollower({
			conversationId: row.conversation_id,
			userId: row.user_id,
			env,
			threadId: row.thread_id
		}).follow();
	}
}
