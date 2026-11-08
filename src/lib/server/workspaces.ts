import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import type { Db } from './db/index.js';
import { getAgentRunByConversation } from './db/repo/agent-runs.js';
import type { ConversationRow } from './db/repo/conversations.js';
import { resolveInside, resolveInsideReal } from './safePath.js';

function root(): string {
	return path.resolve(config.WORKSPACES_VOLUME);
}

function safeJoin(...segments: string[]): string {
	const resolved = resolveInside(root(), path.join(...segments));
	if (!resolved) throw new Error('Path escapes workspace root');
	return resolved;
}

export function conversationWorkspace(conversationId: string): string {
	return safeJoin(conversationId);
}

export async function ensureAttachmentsDir(conversationId: string): Promise<string> {
	const dir = safeJoin(conversationId, 'attachments');
	await fsp.mkdir(dir, { recursive: true });
	return dir;
}

export interface StoredAttachmentFile {
	/** Relative to the workspaces root with `/` separators, like attachment rows' `path`. */
	storedPath: string;
	mtimeMs: number;
}

/**
 * Every regular file in a conversation's `attachments` dir. Agents can write
 * to conversation workspaces, so symlinked dirs and files are skipped.
 */
export async function listAttachmentFiles(): Promise<StoredAttachmentFile[]> {
	const files: StoredAttachmentFile[] = [];
	let entries: fs.Dirent[];
	try {
		entries = await fsp.readdir(root(), { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith('agent-')) continue;
		const dir = path.join(root(), entry.name, 'attachments');
		try {
			if (!(await fsp.lstat(dir)).isDirectory()) continue;
			for (const file of await fsp.readdir(dir, { withFileTypes: true })) {
				if (!file.isFile()) continue;
				const stat = await fsp.lstat(path.join(dir, file.name));
				files.push({
					storedPath: `${entry.name}/attachments/${file.name}`,
					mtimeMs: stat.mtimeMs
				});
			}
		} catch {
			// missing or unreadable attachments dir
		}
	}
	return files;
}

/** Modification time of a stored attachment file, or null if it isn't a file inside the root. */
export async function attachmentFileMtime(storedPath: string): Promise<number | null> {
	const resolved = await resolveInsideReal(root(), storedPath).catch(() => null);
	if (!resolved) return null;
	return fsp.lstat(resolved).then(
		(s) => (s.isFile() ? s.mtimeMs : null),
		() => null
	);
}

/** Deletes a stored attachment file; paths resolving outside the root are left alone. */
export async function removeAttachmentFile(storedPath: string): Promise<boolean> {
	const resolved = await resolveInsideReal(root(), storedPath).catch(() => null);
	if (!resolved) return false;
	return fsp.rm(resolved, { force: true }).then(
		() => true,
		() => false
	);
}

// Attachments live inside conversation workspaces, which agents can write to,
// so the stored path is resolved through symlinks before it is read.
export async function resolveAttachment(storedPath: string): Promise<string> {
	const resolved = await resolveInsideReal(root(), storedPath);
	if (!resolved) throw new Error('Attachment path escapes workspace root');
	if (
		!(await fsp.stat(resolved).then(
			(s) => s.isFile(),
			() => false
		))
	) {
		throw new Error('Attachment not found on disk');
	}
	return resolved;
}

export function agentWorkspaceName(agentId: string, runId: string): string {
	return `agent-${agentId}-${runId}`;
}

export function agentWorkspace(agentId: string, runId: string): string {
	return safeJoin(agentWorkspaceName(agentId, runId));
}

/**
 * The workspace directory a conversation's tools write to: agent-run
 * conversations use their run's agent workspace, everything else its own
 * conversation workspace. Null when an agent-run conversation has no run.
 */
export function workspaceForConversation(
	db: Db,
	conversation: Pick<ConversationRow, 'id' | 'kind'>
): string | null {
	if (conversation.kind !== 'agent-run') return conversationWorkspace(conversation.id);
	const run = getAgentRunByConversation(db, conversation.id);
	return run ? agentWorkspace(run.agent_id, run.id) : null;
}

export function ensureAgentWorkspace(agentId: string, runId: string): string {
	const dir = agentWorkspace(agentId, runId);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function gcAgentWorkspaces(olderThanDays: number): string[] {
	const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
	const removed: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root(), { withFileTypes: true });
	} catch {
		return removed;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith('agent-')) continue;
		const dir = safeJoin(entry.name);
		try {
			if (fs.statSync(dir).mtimeMs >= cutoff) continue;
			fs.rmSync(dir, { recursive: true, force: true });
			removed.push(entry.name);
		} catch {
			// ignore individual failures
		}
	}
	return removed;
}

export function removeConversationWorkspace(conversationId: string): void {
	try {
		fs.rmSync(conversationWorkspace(conversationId), { recursive: true, force: true });
	} catch {
		// ignore individual failures
	}
}

export function gcOrphanConversationWorkspaces(validIds: Set<string>): string[] {
	const removed: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root(), { withFileTypes: true });
	} catch {
		return removed;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith('agent-')) continue;
		if (validIds.has(entry.name)) continue;
		try {
			fs.rmSync(safeJoin(entry.name), { recursive: true, force: true });
			removed.push(entry.name);
		} catch {
			// ignore individual failures
		}
	}
	return removed;
}

export function sanitizeFilename(name: string): string {
	const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
	return base.length > 0 && base !== '.' && base !== '..' ? base.slice(0, 120) : 'file';
}
