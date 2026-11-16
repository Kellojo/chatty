/**
 * The open chat, when the user marked it unread while viewing it (from the
 * sidebar or the header menu). The open chat normally reads itself, so the
 * sidebar hides its unread marker unless it was marked unread on purpose.
 */
export const markedUnread = $state<{ id: string | null }>({ id: null });

/** Marks a conversation read or unread; false when the server refused. */
export async function setConversationRead(
	id: string,
	read: boolean,
	currentId: string
): Promise<boolean> {
	const res = await fetch(`/api/conversations/${id}/read`, {
		method: read ? 'POST' : 'DELETE'
	}).catch(() => null);
	if (!res?.ok) return false;
	if (id === currentId) markedUnread.id = read ? null : id;
	return true;
}
