import { getContext, setContext } from 'svelte';

export interface SidebarState {
	readonly open: boolean;
	readonly isMobile: boolean;
	readonly mobileOpen: boolean;
}

const KEY = Symbol('sidebar');

export function setSidebarState(state: SidebarState) {
	setContext(KEY, state);
}

export function getSidebarState(): SidebarState | undefined {
	return getContext<SidebarState | undefined>(KEY);
}
