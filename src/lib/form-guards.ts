import { beforeNavigate } from '$app/navigation';

/**
 * Asks before leaving the page while a form has unsaved edits: a confirm for
 * in-app navigation, the browser's own prompt for reloads and closing the tab.
 * Call during component setup.
 */
export function guardUnsavedChanges(
	isDirty: () => boolean,
	message = 'Leave this page? Your unsaved changes will be lost.'
): void {
	beforeNavigate(({ cancel, type }) => {
		if (!isDirty()) return;
		// For unloads, cancelling makes the browser show its own prompt.
		if (type === 'leave' || !confirm(message)) cancel();
	});
}

/** Ctrl+S / Cmd+S. */
export function isSaveShortcut(event: KeyboardEvent): boolean {
	return (
		(event.ctrlKey || event.metaKey) &&
		!event.altKey &&
		!event.shiftKey &&
		event.key.toLowerCase() === 's'
	);
}

/**
 * Why a save button is disabled, e.g. "Add a name and a system prompt to create.";
 * null when nothing is missing. Falsy entries are skipped.
 */
export function missingHint(
	needs: (string | false | null | undefined)[],
	action: string
): string | null {
	const items = needs.filter((item): item is string => Boolean(item));
	if (items.length === 0) return null;
	const list =
		items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
	return `Add ${list} to ${action}.`;
}
