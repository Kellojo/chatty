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
 * Classes for a page's first row (its title), so it shares a row with the floating
 * "open sidebar" button wherever the button can overlap it: always on phones, and on
 * desktop while the sidebar is closed and the page column still reaches the left edge
 * (below `xl` for `max-w-6xl` pages, `2xl` for `max-w-7xl`). `lift` pulls the row up
 * to the button's top, `pad` clears it horizontally. The row should be `min-h-10
 * md:min-h-9` so both centre on the button.
 */
export function buttonRowClasses(state: SidebarState | undefined, wide: 'xl' | '2xl' = 'xl') {
	if (!state || state.open) return { lift: 'max-md:-mt-3', pad: 'pl-10 md:pl-0' };
	return wide === 'xl'
		? { lift: 'max-md:-mt-3 md:max-xl:-mt-3.5', pad: 'pl-10 md:max-xl:pl-9 xl:pl-0' }
		: { lift: 'max-md:-mt-3 md:max-2xl:-mt-3.5', pad: 'pl-10 md:max-2xl:pl-9 2xl:pl-0' };
}
