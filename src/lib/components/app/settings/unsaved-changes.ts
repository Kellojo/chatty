import { beforeNavigate } from '$app/navigation';

// Pages with several independent Save buttons share one prompt per navigation.
let promptedFor: object | null = null;

/**
 * Asks before leaving while `isDirty()` is true. Call during component init.
 * A full page unload gets the browser's own "leave site?" dialog instead.
 */
export function guardUnsavedChanges(isDirty: () => boolean) {
	beforeNavigate((navigation) => {
		if (!isDirty()) return;
		if (navigation.type === 'leave') {
			navigation.cancel();
			return;
		}
		// Several guarded sections on one page: ask once for this navigation.
		if (promptedFor === navigation) return;
		promptedFor = navigation;
		if (!confirm('You have unsaved changes. Leave without saving?')) navigation.cancel();
	});
}
