// Client helpers shared by everything that sends a chat message: the chat view
// and the background queue runner.

export type FilePart = { type: 'file'; url: string; mediaType: string; filename: string };

const SKILL_CMD = /^\/skill\s+([a-z0-9][a-z0-9-]{0,63})\s*/i;

/** Splits a leading `/skill <name>` command off the message text. */
export function parseSkillCommand(text: string): { text: string; skill?: string } {
	const match = text.match(SKILL_CMD);
	if (!match) return { text };
	const skill = match[1];
	const rest = text.slice(match[0].length).trim();
	return { text: rest || `Use the ${skill} skill.`, skill };
}

/** Uploads files as conversation attachments and returns their message parts. */
export async function uploadAttachments(
	conversationId: string,
	files: File[]
): Promise<FilePart[]> {
	const parts: FilePart[] = [];
	for (const file of files) {
		const form = new FormData();
		form.append('file', file);
		const res = await fetch(`/api/conversations/${conversationId}/attachments`, {
			method: 'POST',
			body: form
		});
		if (!res.ok) {
			const data = await res.json().catch(() => null);
			throw new Error(data?.message ?? `Failed to upload ${file.name}`);
		}
		const { attachment } = await res.json();
		parts.push({
			type: 'file',
			url: `/api/conversations/${conversationId}/attachments/${attachment.id}`,
			mediaType: attachment.mime,
			filename: attachment.name
		});
	}
	return parts;
}
