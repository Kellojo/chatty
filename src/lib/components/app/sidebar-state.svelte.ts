import { getContext, setContext } from 'svelte';

export interface SidebarState {
	readonly open: boolean;
	readonly mobileOpen: boolean;
}

const KEY = Symbol('sidebar');

export function setSidebarState(state: SidebarState) {
	setContext(KEY, state);
}

export function getSidebarState(): SidebarState | undefined {
	return getContext<SidebarState | undefined>(KEY);
}

/**
 * Classes for a page's first row (its title). `lift` pulls the row up so it centres on
 * the app's top row (24px on phones, 28px wider): the floating "open sidebar" button,
 * the chat header and the sidebar's own header all sit on that line. `pad` clears the
 * button horizontally wherever it can overlap: always on phones, and on desktop while
 * the sidebar is closed and the page column still reaches the left edge (below `xl`, as
 * every page uses `max-w-6xl`). The row should be `min-h-10 md:min-h-9`.
 */
export function buttonRowClasses(state: SidebarState | undefined) {
	const lift = 'max-md:-mt-3 md:-mt-3.5';
	if (!state || state.open) return { lift, pad: 'pl-10 md:pl-0' };
	return { lift, pad: 'pl-10 md:max-xl:pl-9 xl:pl-0' };
}
