import fsp from 'node:fs/promises';
import { getDb } from '../../db/index.js';
import { listAttachmentsByConversation, type AttachmentRow } from '../../db/repo/attachments.js';
import { resolveAttachment } from '../../workspaces.js';

const ATTACHMENT_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The attachment ID inside `ref` — a bare UUID, an "[attachment id: <uuid>]"
 * note or an /api/conversations/.../attachments/<uuid> URL — if any.
 */
export function extractAttachmentId(ref: string): string | undefined {
	return ref.match(ATTACHMENT_ID_RE)?.[0];
}

export type LoadedAttachment =
	{ ok: true; row: AttachmentRow; bytes: Buffer } | { ok: false; error: string };

/**
 * Finds the attachment `ref` points to among this conversation's attachments
 * that `accepts` allows, and reads it from disk. When nothing matches, the
 * error lists the IDs that would have, so the model can retry with one.
 */
export async function loadConversationAttachment(
	conversationId: string,
	ref: string,
	opts: { kind: string; accepts: (mime: string) => boolean }
): Promise<LoadedAttachment> {
	const available = listAttachmentsByConversation(getDb(), conversationId).filter((a) =>
		opts.accepts(a.mime)
	);
	const id = extractAttachmentId(ref);
	const row = id ? available.find((a) => a.id === id) : undefined;
	if (!row) {
		const hint =
			available.length > 0
				? `available ${opts.kind} attachment IDs in this conversation: ${available.map((a) => a.id).join(', ')}`
				: `there are no ${opts.kind} attachments in this conversation`;
		return { ok: false, error: `no ${opts.kind} attachment found for "${ref}" — ${hint}` };
	}
	try {
		return { ok: true, row, bytes: await fsp.readFile(await resolveAttachment(row.path)) };
	} catch {
		return { ok: false, error: `could not read attachment ${row.id} from disk` };
	}
}
