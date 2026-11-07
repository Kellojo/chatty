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
import { providerLabel, repositoryName } from '$lib/coding-environments.js';
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
import { extractText } from '../db/repo/messages.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { connectT3, t3HttpGet, T3ClientError, type T3Connection } from './client.js';
import { ensureFollower, getFollower } from './follower.js';

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
	defaultModel: { providerInstanceId: string; model: string } | null;
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
			defaultModel: modelSelection(p.defaultModelSelection),
			defaultWorkspaceMode: workspaceModeFromEnvMode(p.defaultThreadEnvMode)
		}))
		.sort((a, b) => a.title.localeCompare(b.title));
}

function modelSelection(value: unknown): { providerInstanceId: string; model: string } | null {
	const selection = rec(value);
	const instanceId = str(selection?.instanceId);
	const model = str(selection?.model);
	return instanceId && model ? { providerInstanceId: instanceId, model } : null;
}

function parseModels(config: unknown): CodingModelOption[] {
	const providers = Array.isArray(rec(config)?.providers)
		? (rec(config)!.providers as unknown[])
		: [];
	const options: CodingModelOption[] = [];
	for (const entry of providers) {
		const p = rec(entry);
		const instanceId = str(p?.instanceId);
		const driver = str(p?.driver);
		if (!p || !instanceId || !driver) continue;
		if (p.enabled === false || p.installed === false || p.availability === 'unavailable') continue;
		if (p.status === 'error' || p.status === 'disabled') continue;
		const label = str(p.displayName) ?? providerLabel(driver);
		for (const m of Array.isArray(p.models) ? p.models : []) {
			const model = rec(m);
			const slug = str(model?.slug);
			if (!model || !slug || model.isLegacy === true) continue;
			options.push({
				providerInstanceId: instanceId,
				provider: driver,
				providerLabel: label,
				model: slug,
				label: str(model.name) ?? slug
			});
		}
	}
	return options;
}

export async function getCodingOptions(
	userId: string,
	environmentId: string,
	db: Db = getDb()
): Promise<{
	projects: CodingProjectOption[];
	models: CodingModelOption[];
	defaultModel: { providerInstanceId: string; model: string } | null;
	defaultAutonomy: CodingAutonomy | null;
	defaultWorkspaceMode: CodingWorkspaceMode | null;
}> {
	const env = requireEnvironment(db, userId, environmentId);
	try {
		const [projects, config] = await Promise.all([
			listRemoteProjects(env),
			withConnection(env, (conn) => conn.call('server.getConfig', {}))
		]);
		const models = parseModels(config);
		// T3 resolves a new thread's defaults as: project override, then the
		// user's server-wide settings. Mirror that so Chatty starts the same way.
		const settings = rec(rec(config)?.settings);
		const overrides = rec(settings?.projectSettingsOverrides);
		const override = (projectId: string) => rec(overrides?.[projectId]);
		const available = (m: { providerInstanceId: string; model: string } | null) =>
			m && models.some((o) => o.providerInstanceId === m.providerInstanceId && o.model === m.model)
				? m
				: null;
		const defaultModel =
			available(modelSelection(settings?.defaultModelSelection)) ??
			available(projects.find((p) => p.defaultModel)?.defaultModel ?? null) ??
			(models[0]
				? { providerInstanceId: models[0].providerInstanceId, model: models[0].model }
				: null);
		return {
			projects: projects.map((p) => ({
				id: p.id,
				title: p.title,
				defaultBranch: null,
				isGitRepo: p.isGitRepo,
				defaultAutonomy: autonomyFromRuntimeMode(override(p.id)?.defaultRuntimeMode),
				defaultWorkspaceMode:
					workspaceModeFromEnvMode(override(p.id)?.defaultThreadEnvMode) ?? p.defaultWorkspaceMode
			})),
			models,
			defaultModel,
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
	baseBranch?: string;
}

/**
 * Creates the conversation + task record. Nothing runs remotely yet: the task
 * starts with the first message sent through the normal chat flow.
 */
export async function createCodingTask(
	userId: string,
	input: CreateCodingTaskInput,
	db: Db = getDb()
) {
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

	const conversation = db.transaction(() => {
		const conv = createConversation(db, userId, { kind: 'chat', mode: 'agent' });
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
		return conv;
	})();
	publishServerEvent(userId, { type: 'chat.created', conversationId: conversation.id });
	return { conversation, coding: getCodingConversation(db, conversation.id)! };
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
	if (!coding.environment_id) {
		throw new CodingTaskError(409, 'The coding environment for this task was removed');
	}
	const env = requireEnvironment(db, userId, coding.environment_id);
	const text = extractText(message.parts).trim();
	if (!text) throw new CodingTaskError(400, 'Message is empty');
	if (message.parts.some((p) => p.type === 'file')) {
		throw new CodingTaskError(400, 'Attachments are not supported for coding tasks yet');
	}

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
	return createStreamReplayResponse(coding.conversation_id) ?? new Response(null, { status: 204 });
}

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
		throw asTaskError(e, 'Could not send the answer to the coding agent');
	}
	void follower.follow();
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
