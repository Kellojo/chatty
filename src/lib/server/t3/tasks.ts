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
import {
	codingDeclineOption,
	repositoryName,
	type CodingModelRef
} from '$lib/coding-environments.js';
import { autonomyFromRuntimeMode, CODING_RUNTIME_MODES } from '$lib/coding-task-details.js';
import { createStreamReplayResponse } from '../chat/replay.js';
import { decryptSecret } from '../crypto.js';
import { getDb, type Db } from '../db/index.js';
import {
	recordCodingRequestAnswer,
	createCodingConversation,
	getCodingConversation,
	getCodingConversationForUser,
	listLiveCodingConversations,
	updateCodingConversation,
	type CodingConversationRow
} from '../db/repo/coding-conversations.js';
import { getCodingEnvironment, type CodingEnvironmentRow } from '../db/repo/coding-environments.js';
import { createConversation, getConversation } from '../db/repo/conversations.js';
import { createMessage, extractText } from '../db/repo/messages.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import {
	ATTACHMENTS_ONLY_TEXT,
	CodingAttachmentError,
	readCodingAttachments,
	uploadCodingAttachments,
	type CodingUpload
} from './attachments.js';
import { t3HttpGet, T3ClientError } from './client.js';
import { ensureFollower, getFollower } from './follower.js';
import { withT3Connection } from './pool.js';
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
export const RUNTIME_MODES: Record<CodingAutonomy, string> = CODING_RUNTIME_MODES;

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

/** One-off calls share the environment's socket with its followers (see ./pool.ts). */
const withConnection = withT3Connection;

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

export interface CodingFolderEntry {
	name: string;
	path: string;
}

/**
 * Folder suggestions on the environment for a partially typed path (`~/co`,
 * `/srv/`). Same lookup as T3's own "add project" path field: folders in the
 * parent of the typed path whose name starts with its last segment.
 * A path that can't be read yet (still being typed) gives no suggestions.
 */
export async function browseCodingFolders(
	userId: string,
	environmentId: string,
	partialPath: string,
	db: Db = getDb()
): Promise<{ parentPath: string | null; entries: CodingFolderEntry[] }> {
	const env = requireEnvironment(db, userId, environmentId);
	try {
		const result = rec(
			await withConnection(env, (conn) => conn.call('filesystem.browse', { partialPath }))
		);
		const entries = Array.isArray(result?.entries) ? result.entries : [];
		return {
			parentPath: str(result?.parentPath),
			entries: entries
				.map(rec)
				.filter((e): e is Rec => e !== null && !!str(e.name) && !!str(e.fullPath))
				.map((e) => ({ name: String(e.name), path: String(e.fullPath) }))
		};
	} catch (e) {
		if (e instanceof T3ClientError && e.kind === 'remote') return { parentPath: null, entries: [] };
		throw asTaskError(e, 'Could not list folders on the coding environment');
	}
}

/** Path equality across separators, trailing slashes and (on Windows-style paths) case. */
function samePath(a: string, b: string): boolean {
	const norm = (p: string) => {
		const trimmed = p.replace(/[\\/]+$/, '').replace(/\\/g, '/');
		return /^[a-z]:\//i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
	};
	return norm(a) === norm(b);
}

export interface CreateCodingProjectInput {
	environmentId: string;
	title: string;
	/** Clone source (`owner/repo` or a git URL). */
	repository?: string;
	/** Existing folder on the environment to add as is. */
	path?: string;
}

/**
 * Creates a project on the environment: a fresh git repository named after
 * `title`, a clone of `repository` into the user's T3 project folder, or an
 * existing folder at `path`.
 */
export async function createCodingProject(
	userId: string,
	input: CreateCodingProjectInput,
	db: Db = getDb()
): Promise<{ project: { id: string; title: string }; warning: string | null }> {
	const env = requireEnvironment(db, userId, input.environmentId);
	try {
		if (input.path) return await addExistingFolder(env, input.title, input.path);
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

/**
 * Registers an existing folder as a project. T3's `projects.mutate` reports
 * every failure as a bare "Failed to mutate project.", so the likely mistakes
 * (missing folder, folder already a project) are checked first.
 */
async function addExistingFolder(
	env: CodingEnvironmentRow,
	title: string,
	rawPath: string
): Promise<{ project: { id: string; title: string }; warning: null }> {
	const path = rawPath.trim();
	return await withConnection(env, async (conn) => {
		// Browsing "<path>/" resolves `~` and relative bits to the absolute
		// folder, and fails when it doesn't exist or isn't a folder.
		let workspaceRoot: string | null;
		try {
			const listed = rec(
				await conn.call('filesystem.browse', { partialPath: `${path.replace(/[\\/]+$/, '')}/` })
			);
			workspaceRoot = str(listed?.parentPath);
		} catch (e) {
			if (e instanceof T3ClientError && e.kind === 'remote') {
				throw new CodingTaskError(400, `No folder at ${path} on ${env.name}`);
			}
			throw e;
		}
		if (!workspaceRoot)
			throw new CodingTaskError(502, 'The environment did not resolve the folder');

		const existing = (await listRemoteProjects(env)).find(
			(p) => p.workspaceRoot && samePath(p.workspaceRoot, workspaceRoot)
		);
		if (existing) {
			throw new CodingTaskError(409, `This folder is already the project “${existing.title}”`);
		}

		const projectId = randomUUID();
		try {
			await conn.call('projects.mutate', {
				type: 'project.create',
				commandId: randomUUID(),
				projectId,
				title,
				workspaceRoot
			});
		} catch (e) {
			if (e instanceof T3ClientError && e.kind === 'remote') {
				// Most often the folder belongs to an archived project, which the list above hides.
				throw new CodingTaskError(
					409,
					`${env.name} would not add this folder. Is it an archived project in T3 Code?`
				);
			}
			throw e;
		}
		return { project: { id: projectId, title }, warning: null };
	});
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
		// T3 fills in `repositoryIdentity` a moment after a project is added, so a
		// brand-new project looks like it has no git yet. Ask git before refusing.
		if (!(await isGitWorkspace(env, project.workspaceRoot))) {
			throw new CodingTaskError(400, 'Worktrees need a git repository; use the project checkout');
		}
		project = { ...project, isGitRepo: true };
	}
	return { env, project };
}

async function isGitWorkspace(env: CodingEnvironmentRow, cwd: string | null): Promise<boolean> {
	if (!cwd) return false;
	try {
		const result = rec(
			await withConnection(env, (conn) =>
				conn.call('vcs.listRefs', { cwd, refKind: 'local', limit: 1 })
			)
		);
		return result?.isRepo === true;
	} catch (e) {
		throw asTaskError(e, 'Could not reach the coding environment');
	}
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
	let files: CodingUpload[];
	try {
		files = await readCodingAttachments(db, coding.conversation_id, message.parts);
	} catch (e) {
		if (e instanceof CodingAttachmentError) throw new CodingTaskError(400, e.message);
		throw e;
	}
	const text = extractText(message.parts).trim() || (files.length > 0 ? ATTACHMENTS_ONLY_TEXT : '');
	if (!text) throw new CodingTaskError(400, 'Message is empty');
	await sendCodingTurn(userId, coding, { id: message.id, text, files }, db);
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

/** A user message on its way to the thread. */
interface CodingTurnMessage {
	id: string;
	text: string;
	/** Attachments, uploaded to T3 right before the message is sent. */
	files?: readonly CodingUpload[];
}

/** Launches the thread on the first message, otherwise sends a follow-up. */
function sendCodingTurn(
	userId: string,
	coding: CodingConversationRow,
	message: CodingTurnMessage,
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
	message: CodingTurnMessage,
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
		const files = message.files ?? [];
		const attachments =
			files.length === 0
				? []
				: await withConnection(env, (conn) =>
						uploadCodingAttachments(conn, env, { threadId, messageId: message.id, files })
					);
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
				message: { id: message.id, text, attachments }
			});
		} else {
			await follower.sendMessage({ id: message.id, text, attachments });
		}
	} catch (e) {
		const firstLaunch = !coding.thread_id;
		// The launch may have reached T3 with only the response lost (e.g. a
		// timeout). Relaunching can't count on T3 deduping (each launch sends a new
		// commandId), so check: if the thread exists, treat it as launched.
		if (firstLaunch && (await threadExistsRemotely(env, threadId))) {
			log.warn('Coding thread launch reported an error but the thread exists', {
				conversationId: coding.conversation_id,
				error: e instanceof Error ? e.message : String(e)
			});
			void follower.follow();
			return;
		}
		follower.failTurn();
		const error = asTaskError(e, 'Could not start the coding agent');
		updateCodingConversation(db, coding.conversation_id, {
			lastError: error.message,
			// No thread on T3: forget its id so the next message launches again.
			...(firstLaunch ? { threadId: null, status: 'failed' as const } : {})
		});
		publishServerEvent(userId, {
			type: 'coding.task.updated',
			conversationId: coding.conversation_id
		});
		// Without a thread there is nothing to follow; an existing thread is
		// followed so the follower syncs and later stops on idle or gives up.
		if (firstLaunch) follower.stop();
		else void follower.follow();
		throw error;
	}
	void follower.follow();
}

/** Whether `threadId` exists on `env`; false when that can't be determined. */
async function threadExistsRemotely(env: CodingEnvironmentRow, threadId: string): Promise<boolean> {
	try {
		const shell = rec(
			await t3HttpGet(
				env.base_url,
				decryptSecret(env.token_enc),
				'/api/orchestration/shell?omitIdleSubagents=1'
			)
		);
		return [shell?.threads, shell?.archivedThreads]
			.flatMap((list) => (Array.isArray(list) ? list : []))
			.some((t) => rec(t)?.id === threadId);
	} catch {
		return false;
	}
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
			// A typed reply without a decision says what to do instead: it declines,
			// with the reply as the agent's feedback.
			const decision = input.optionId ?? (text ? codingDeclineOption(pending)?.id : undefined);
			if (!decision || !pending.options.some((o) => o.id === decision)) {
				throw new CodingTaskError(400, 'Choose one of the offered options');
			}
			// Stored before sending: T3 may report the request resolved (and the
			// timeline re-render) before the send returns. The decision itself shows
			// as the outcome; only a note is worth keeping.
			if (text) rememberAnswer(db, conversationId, pending.requestId, text);
			await follower.respond({
				requestId: pending.requestId,
				decision,
				feedback: text
			});
		} else {
			const option = pending.options.find((o) => o.id === input.optionId);
			const answer = text ?? option?.label;
			if (!answer) throw new CodingTaskError(400, 'Choose an option or type an answer');
			// Shown only once T3 reports the request resolved, so storing it first is
			// safe even if the send fails (a retry overwrites it).
			rememberAnswer(db, conversationId, pending.requestId, answer);
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
 * Keeps the user's words for the timeline. Best-effort: failing to store them
 * mustn't keep the answer from reaching T3.
 */
function rememberAnswer(db: Db, conversationId: string, requestId: string, answer: string): void {
	try {
		recordCodingRequestAnswer(db, conversationId, requestId, answer);
	} catch (e) {
		log.warn('Could not store the answer to a coding request', {
			conversationId,
			error: e instanceof Error ? e.message : String(e)
		});
	}
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

export interface CodingTaskSettingsInput {
	providerInstanceId?: string;
	model?: string;
	autonomy?: CodingAutonomy;
}

/**
 * Changes a task's model and/or autonomy. Once the thread exists, T3 is told
 * first (`thread.model-selection.set`, `thread.runtime-mode.set`, as T3's own
 * client does) and the change is only stored when it accepted; before that the
 * stored values are what the launch uses. A run in progress keeps going; T3
 * applies the change from the next turn.
 */
export async function updateCodingTaskSettings(
	userId: string,
	conversationId: string,
	input: CodingTaskSettingsInput,
	db: Db = getDb()
): Promise<CodingConversationRow> {
	if (!getCodingConversationForUser(db, userId, conversationId)) {
		throw new CodingTaskError(404, 'Coding task not found');
	}
	if (!!input.providerInstanceId !== !!input.model) {
		throw new CodingTaskError(400, 'Choose a model and its provider together');
	}
	// Serialized with sent turns, so a launch in flight can't miss the change.
	return serializedByConversation(conversationId, async () => {
		const row = getCodingConversation(db, conversationId);
		if (!row) throw new CodingTaskError(404, 'Coding task not found');
		const providerInstanceId = input.providerInstanceId ?? row.provider_instance_id;
		const model = input.model ?? row.model;
		const runtimeMode = input.autonomy ? RUNTIME_MODES[input.autonomy] : row.runtime_mode;
		const modelChanged = providerInstanceId !== row.provider_instance_id || model !== row.model;
		const runtimeChanged = runtimeMode !== row.runtime_mode;
		if (!modelChanged && !runtimeChanged) return row;

		if (row.thread_id) {
			if (!row.environment_id) {
				throw new CodingTaskError(409, 'The coding environment for this task was removed');
			}
			const env = requireEnvironment(db, userId, row.environment_id);
			const threadId = row.thread_id;
			try {
				await withConnection(env, async (conn) => {
					if (modelChanged) {
						await conn.call('orchestration.dispatchCommand', {
							type: 'thread.model-selection.set',
							commandId: randomUUID(),
							threadId,
							modelSelection: { instanceId: providerInstanceId, model }
						});
						// Stored as soon as T3 took it, even if the runtime mode fails next.
						updateCodingConversation(db, conversationId, { providerInstanceId, model });
					}
					if (runtimeChanged) {
						await conn.call('orchestration.dispatchCommand', {
							type: 'thread.runtime-mode.set',
							commandId: randomUUID(),
							threadId,
							runtimeMode
						});
					}
				});
			} catch (e) {
				publishServerEvent(userId, { type: 'coding.task.updated', conversationId });
				throw asTaskError(e, 'Could not change the coding agent settings');
			}
		}
		const updated = updateCodingConversation(db, conversationId, {
			providerInstanceId,
			model,
			runtimeMode
		})!;
		publishServerEvent(userId, { type: 'coding.task.updated', conversationId });
		return updated;
	});
}

/**
 * Archives a deleted task's thread on T3, so it leaves T3's thread list too
 * (Chatty already won't import it again). Best-effort: failures are logged,
 * never thrown.
 */
export async function archiveCodingThread(
	userId: string,
	conversationId: string,
	db: Db = getDb()
): Promise<void> {
	const coding = getCodingConversation(db, conversationId);
	if (!coding?.thread_id || !coding.environment_id) return;
	const env = getCodingEnvironment(db, userId, coding.environment_id);
	if (!env || env.enabled !== 1) return;
	try {
		await withConnection(env, (conn) =>
			conn.call('orchestration.dispatchCommand', {
				type: 'thread.archive',
				commandId: randomUUID(),
				threadId: coding.thread_id
			})
		);
	} catch (e) {
		log.warn('Could not archive the coding thread on T3', {
			conversationId,
			error: e instanceof Error ? e.message : String(e)
		});
	}
}
