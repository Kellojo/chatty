// A coding task's changes as per-file diffs, read from T3 Code's review RPC
// (`review.getDiffPreview`, what T3's own diff panel asks for: the working tree
// and the branch against its base, for the thread's worktree or the project
// checkout). Tokens without filesystem access get the thread's own diff
// (`orchestration.getFullThreadDiff`: what the agent changed across its runs).

import {
	parseUnifiedDiff,
	type CodingDiffFile,
	type CodingDiffSource,
	type CodingDiffSourceKind,
	type CodingTaskDiff
} from '$lib/coding-diff.js';
import { decryptSecret } from '../crypto.js';
import type { Db } from '../db/index.js';
import { getCodingConversationForUser } from '../db/repo/coding-conversations.js';
import { getCodingEnvironment, type CodingEnvironmentRow } from '../db/repo/coding-environments.js';
import { listMessages } from '../db/repo/messages.js';
import { t3HttpGet, T3ClientError } from './client.js';
import { withT3Connection } from './pool.js';
import { CodingTaskError } from './tasks.js';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const count = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);

const SOURCE_KINDS = new Set<string>(['working-tree', 'branch-range', 'commit']);
/** Longest diff text parsed; T3 truncates long diffs itself, this only guards memory. */
const MAX_DIFF_CHARS = 8 * 1024 * 1024;

function parseSource(value: unknown): CodingDiffSource | null {
	const s = rec(value);
	const kind = str(s?.kind);
	if (!s || !kind || !SOURCE_KINDS.has(kind)) return null;
	const text = typeof s.diff === 'string' ? s.diff : '';
	const files = parseUnifiedDiff(text.slice(0, MAX_DIFF_CHARS));
	let truncated = s.truncated === true || text.length > MAX_DIFF_CHARS;
	// T3's per-file stats cover files a truncated diff left out.
	const known = new Set(files.map((f) => f.path));
	for (const entry of Array.isArray(s.files) ? s.files : []) {
		const f = rec(entry);
		const path = str(f?.path);
		if (!f || !path || known.has(path)) continue;
		const missing: CodingDiffFile = {
			path,
			previousPath: str(f.previousPath),
			status: f.previousPath ? 'renamed' : 'modified',
			additions: count(f.additions),
			deletions: count(f.deletions),
			binary: false,
			lines: [],
			truncated: true
		};
		files.push(missing);
		known.add(path);
		truncated = true;
	}
	return {
		kind: kind as CodingDiffSourceKind,
		title: str(s.title) ?? (kind === 'working-tree' ? 'Uncommitted changes' : 'Branch changes'),
		baseRef: str(s.baseRef),
		files,
		truncated: truncated || files.some((f) => f.truncated)
	};
}

/** Reads T3's `review.getDiffPreview` answer. */
export function parseDiffPreview(result: unknown): CodingTaskDiff {
	const sources = rec(result)?.sources;
	return {
		sources: (Array.isArray(sources) ? sources : [])
			.map(parseSource)
			.filter((s): s is CodingDiffSource => s !== null)
	};
}

/** The thread's entry in T3's thread list (active or archived), if any. */
async function shellThread(env: CodingEnvironmentRow, threadId: string): Promise<Rec | null> {
	const shell = rec(
		await t3HttpGet(
			env.base_url,
			decryptSecret(env.token_enc),
			'/api/orchestration/shell?omitIdleSubagents=1'
		)
	);
	return (
		[shell?.threads, shell?.archivedThreads]
			.flatMap((list) => (Array.isArray(list) ? list : []))
			.map(rec)
			.find((t) => t?.id === threadId) ?? null
	);
}

/** Where the task's thread works: its worktree, else the project checkout. */
async function taskWorkingDirectory(
	env: CodingEnvironmentRow,
	thread: Rec | null,
	projectId: string
): Promise<string | null> {
	const worktree = str(thread?.worktreePath);
	if (worktree) return worktree;
	const projects = rec(
		await t3HttpGet(env.base_url, decryptSecret(env.token_enc), '/api/projects')
	)?.projects;
	const project = (Array.isArray(projects) ? projects : [])
		.map(rec)
		.find((p) => p?.id === projectId);
	return str(project?.workspaceRoot);
}

/**
 * T3's "turn count" for a thread diff: the latest run with a usable checkpoint
 * (T3 diffs between checkpoints, and a running or file-less run has none).
 * 0 when there is none yet.
 */
export function latestCheckpointTurn(projection: unknown): number {
	const checkpoints = rec(projection)?.checkpoints;
	let latest = 0;
	for (const entry of Array.isArray(checkpoints) ? checkpoints : []) {
		const c = rec(entry);
		const ordinal = c?.appRunOrdinal;
		if (c?.status === 'ready' && typeof ordinal === 'number' && ordinal > latest) latest = ordinal;
	}
	return latest;
}

/** Reads T3's `orchestration.getFullThreadDiff` answer (`{ threadId, diff }`). */
export function parseThreadDiff(result: unknown): CodingTaskDiff {
	const source = parseSource({
		kind: 'commit',
		title: 'Changes by the agent',
		diff: rec(result)?.diff
	});
	return { sources: source && source.files.length > 0 ? [source] : [] };
}

/**
 * The files the thread's runs reported changing, from the checkpoint steps Chatty
 * stored for the task's messages (oldest first), with summed line counts but no
 * line diffs. Steps stored before per-file counts were kept list paths only.
 */
export function changedFilesSummary(messages: { parts: unknown }[]): CodingTaskDiff {
	const byPath = new Map<string, CodingDiffFile>();
	for (const message of messages) {
		const parts = Array.isArray(message.parts) ? message.parts : [];
		for (const raw of parts) {
			const part = rec(raw);
			if (part?.type !== 'dynamic-tool' || part.toolName !== 'checkpoint') continue;
			const input = rec(part.input);
			const changes = Array.isArray(input?.changes)
				? input.changes
				: (Array.isArray(input?.files) ? input.files : []).map((path) => ({ path }));
			for (const change of changes) collectChange(byPath, rec(change));
		}
	}
	return summarySource(byPath);
}

function collectChange(byPath: Map<string, CodingDiffFile>, f: Rec | null): void {
	const path = str(f?.path);
	if (!f || !path) return;
	const kind = str(f.kind);
	const file = byPath.get(path) ?? {
		path,
		previousPath: null,
		status: 'modified',
		additions: 0,
		deletions: 0,
		binary: false,
		lines: [],
		truncated: true
	};
	file.additions += count(f.additions);
	file.deletions += count(f.deletions);
	// The latest run decides whether the file exists now.
	if (kind === 'added' || kind === 'deleted' || kind === 'modified') file.status = kind;
	byPath.set(path, file);
}

function summarySource(byPath: Map<string, CodingDiffFile>): CodingTaskDiff {
	if (byPath.size === 0) return { sources: [] };
	return {
		sources: [
			{
				kind: 'commit',
				title: 'Files changed by the agent (line diffs need filesystem access)',
				baseRef: null,
				files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
				truncated: true
			}
		]
	};
}

/**
 * A token without the `filesystem:read` scope (e.g. one made from a read-only
 * pairing link) can't use the review RPC; the thread diff only needs
 * `orchestration:read`.
 */
function missingFilesystemScope(e: unknown): boolean {
	return e instanceof T3ClientError && /filesystem:read/.test(e.message);
}

export async function getCodingTaskDiff(
	db: Db,
	userId: string,
	conversationId: string
): Promise<CodingTaskDiff> {
	const coding = getCodingConversationForUser(db, userId, conversationId);
	if (!coding) throw new CodingTaskError(404, 'Coding task not found');
	// Nothing ran yet, so nothing changed.
	if (!coding.thread_id) return { sources: [] };
	if (!coding.environment_id) {
		throw new CodingTaskError(409, 'The coding environment for this task was removed');
	}
	const env = getCodingEnvironment(db, userId, coding.environment_id);
	if (!env || env.enabled !== 1)
		throw new CodingTaskError(409, 'This coding environment is disabled');
	const threadId = coding.thread_id;
	try {
		const thread = await shellThread(env, threadId);
		const cwd = await taskWorkingDirectory(env, thread, coding.project_id);
		if (!cwd) throw new CodingTaskError(404, 'The task has no working directory on T3');
		try {
			const result = await withT3Connection(env, (conn) =>
				conn.call('review.getDiffPreview', { cwd, ignoreWhitespace: false })
			);
			return parseDiffPreview(result);
		} catch (e) {
			if (!missingFilesystemScope(e)) throw e;
			return await withT3Connection(env, async (conn) => {
				const projection = await conn.call('orchestration.getThreadProjection', { threadId });
				const toTurnCount = latestCheckpointTurn(projection);
				if (toTurnCount > 0) {
					const diff = parseThreadDiff(
						await conn.call('orchestration.getFullThreadDiff', {
							threadId,
							toTurnCount,
							ignoreWhitespace: false
						})
					);
					if (diff.sources.length > 0) return diff;
				}
				// No run checkpoints to diff (e.g. a thread working in the project
				// folder itself): list the files the runs reported changing.
				return changedFilesSummary(
					listMessages(db, conversationId).map((m) => ({ parts: JSON.parse(m.parts) as unknown }))
				);
			});
		}
	} catch (e) {
		if (e instanceof CodingTaskError) throw e;
		if (e instanceof T3ClientError) {
			throw new CodingTaskError(
				e.kind === 'unauthorized' ? 403 : 502,
				e.kind === 'remote' ? `T3 could not read the changes: ${e.message}` : e.message
			);
		}
		throw e;
	}
}
