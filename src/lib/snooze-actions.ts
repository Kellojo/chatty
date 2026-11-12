// Snooze requests from the UI (menus and the custom-time dialog), with their toasts.

import { toast } from 'svelte-sonner';
import { formatSnoozeTime, isSnoozed } from './snooze.js';
import type { Conversation } from './types.js';

/** Called after a snooze or wake went through: the new end, null when woken. */
export type SnoozeChanged = (until: number | null) => void | Promise<void>;

async function request(id: string, until: number | null): Promise<boolean> {
	const res = await fetch(`/api/conversations/${id}/snooze`, {
		method: until === null ? 'DELETE' : 'POST',
		headers: until === null ? undefined : { 'content-type': 'application/json' },
		body: until === null ? undefined : JSON.stringify({ until })
	}).catch(() => null);
	return !!res?.ok;
}

/** Snoozes `c` until `until`, with an Undo that restores the previous snooze and pin. */
export async function snoozeConversation(
	c: Conversation,
	until: number,
	onchanged: SnoozeChanged
): Promise<boolean> {
	const { id, pinned } = c;
	const previous = isSnoozed(c) ? c.snoozedUntil : null;
	if (!(await request(id, until))) {
		toast.error('Failed to snooze');
		return false;
	}
	await onchanged(until);
	toast.success(`Snoozed until ${formatSnoozeTime(until)}`, {
		action: {
			label: 'Undo',
			onClick: async () => {
				const restore = previous !== null && previous > Date.now() ? previous : null;
				if (!(await request(id, restore))) return void toast.error('Failed to undo the snooze');
				// Snoozing unpins, so undoing it restores the pin.
				if (pinned) await fetch(`/api/conversations/${id}/pin`, { method: 'POST' });
				await onchanged(restore);
			}
		}
	});
	return true;
}

/** Ends `c`'s snooze now. */
export async function wakeConversation(c: Conversation, onchanged: SnoozeChanged): Promise<void> {
	if (!(await request(c.id, null))) {
		toast.error('Failed to wake');
		return;
	}
	await onchanged(null);
}
