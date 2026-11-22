// Text files a coding agent links to in its replies (`[a.ts:4](/repo/a.ts:4)`),
// read from the T3 machine with `projects.readFile` (needs the token's
// `filesystem:read` scope). T3 only reads inside the `cwd` it is given, so a
// file inside the task's workspace is read relative to it; one outside is read
// only if the agent itself put that path in the conversation, the same rule
// coding images follow.

import type { CodingFileContents } from '$lib/coding-file-links.js';
import type { Db } from '../db/index.js';
import { getCodingConversationForUser } from '../db/repo/coding-conversations.js';
import { getCodingEnvironment } from '../db/repo/coding-environments.js';
import { isReferenced } from './assets.js';
import { T3ClientError } from './client.js';
import { withT3Connection } from './pool.js';
import { shellThread, taskWorkingDirectory } from './review.js';
import { CodingTaskError } from './tasks.js';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;

const WINDOWS_ROOT = /^(?:[a-z]:[\\/]|\\\\)/i;

const isAbsolute = (path: string) =>
	WINDOWS_ROOT.test(path) || path.startsWith('/') || path.startsWith('~');

/** `/`-separated, without `./` segments or a trailing slash. */
function normalize(path: string): string {
	return path
		.replaceAll('\\', '/')
		.replace(/(^|\/)(?:\.\/)+/g, '$1')
		.replace(/(?<=.)\/+$/, '');
}

/**
 * `path` relative to the workspace root `cwd` (`/`-separated), or null when
 * it's an absolute path outside it. Windows paths compare case-insensitively.
 */
export function workspaceRelativePath(cwd: string, path: string): string | null {
	const file = normalize(path);
	if (!isAbsolute(path)) {
		// Climbing out of the workspace is T3's to refuse, but don't ask it to.
		if (file.split('/').includes('..') || !file) return null;
		return file;
	}
	const root = normalize(cwd);
	const fold = WINDOWS_ROOT.test(cwd) ? (s: string) => s.toLowerCase() : (s: string) => s;
	const prefix = root.endsWith('/') ? root : `${root}/`;
	if (!fold(file).startsWith(fold(prefix))) return null;
	const rest = file.slice(prefix.length);
	return rest && !rest.split('/').includes('..') ? rest : null;
}

/** Joins a workspace-relative path onto `cwd` with the separator `cwd` uses. */
function joinPath(cwd: string, relative: string): string {
	const sep = WINDOWS_ROOT.test(cwd) && !cwd.includes('/') ? '\\' : '/';
	return cwd.replace(/[\\/]+$/, '') + sep + relative.replaceAll('/', sep);
}

/** `C:\a\b.ts` → [`C:\a`, `b.ts`]. */
function splitAbsolute(path: string): [string, string] | null {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	if (cut <= 0 || cut === path.length - 1) return null;
	// Keep the root's separator: `/a.ts` → `/`, `C:\a.ts` → `C:\`.
	const dir = path.slice(0, cut) || path.slice(0, 1);
	return [/^[a-z]:$/i.test(dir) ? `${dir}${path[cut]}` : dir, path.slice(cut + 1)];
}

export async function readCodingFile(
	db: Db,
	userId: string,
	conversationId: string,
	path: string
): Promise<CodingFileContents> {
	const coding = getCodingConversationForUser(db, userId, conversationId);
	if (!coding) throw new CodingTaskError(404, 'Coding task not found');
	if (!coding.environment_id || !coding.thread_id) {
		throw new CodingTaskError(409, 'This coding task has no thread on T3 yet');
	}
	const env = getCodingEnvironment(db, userId, coding.environment_id);
	if (!env || env.enabled !== 1)
		throw new CodingTaskError(409, 'This coding environment is disabled');

	try {
		const thread = await shellThread(env, coding.thread_id);
		const workspace = await taskWorkingDirectory(env, thread, coding.project_id);
		const inside = workspace ? workspaceRelativePath(workspace, path) : null;

		let cwd: string;
		let relativePath: string;
		let absolutePath: string;
		if (workspace && inside) {
			cwd = workspace;
			relativePath = inside;
			absolutePath = isAbsolute(path) ? path : joinPath(workspace, inside);
		} else {
			// T3 doesn't expand `~`, and Chatty can't know the coding machine's home folder.
			if (path.startsWith('~')) {
				throw new CodingTaskError(
					404,
					"Paths starting with ~ can't be opened. Ask the agent for the file's full path."
				);
			}
			const parts = WINDOWS_ROOT.test(path) || path.startsWith('/') ? splitAbsolute(path) : null;
			if (!parts || !isReferenced(db, conversationId, path)) {
				throw new CodingTaskError(404, "This file is outside the task's workspace");
			}
			[cwd, relativePath] = parts;
			absolutePath = path;
		}

		const result = rec(
			await withT3Connection(env, (conn) =>
				conn.call('projects.readFile', { cwd, relativePath, allowMissing: true })
			)
		);
		const contents = typeof result?.contents === 'string' ? result.contents : '';
		return {
			absolutePath,
			workspacePath: inside,
			exists: result?.exists !== false,
			contents,
			byteLength: typeof result?.byteLength === 'number' ? result.byteLength : contents.length,
			truncated: result?.truncated === true
		};
	} catch (e) {
		if (e instanceof CodingTaskError) throw e;
		if (e instanceof T3ClientError) {
			if (e.kind === 'unauthorized') {
				throw new CodingTaskError(
					403,
					/filesystem:read/.test(e.message)
						? 'Re-pair this coding environment to open files from it (it needs file read access)'
						: 'T3 rejected this coding environment’s access token (expired or revoked?). Pair it again to open files.'
				);
			}
			throw new CodingTaskError(e.kind === 'remote' ? 422 : 502, e.message);
		}
		throw e;
	}
}
