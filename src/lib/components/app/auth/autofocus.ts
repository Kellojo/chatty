/**
 * Focus the element on mount, but only on fine-pointer (desktop) devices so
 * touch users don't get the on-screen keyboard thrown at them on page load.
 */
export function autofocus(node: HTMLElement) {
	if (window.matchMedia('(pointer: fine)').matches) node.focus();
}
