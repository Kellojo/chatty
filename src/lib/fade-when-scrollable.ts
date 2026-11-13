/**
 * Svelte attachment that marks a scroll area with `data-more-below` while more content
 * sits below the visible part, so it can fade out at the bottom as a hint to scroll:
 * `{@attach fadeWhenScrollable}` plus
 * `data-more-below:[mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]`.
 */
export function fadeWhenScrollable(el: HTMLElement) {
	const update = () => {
		const more = el.scrollHeight - el.scrollTop - el.clientHeight > 4;
		el.toggleAttribute('data-more-below', more);
	};
	update();
	const observer = new ResizeObserver(update);
	observer.observe(el);
	for (const child of el.children) observer.observe(child);
	const mutations = new MutationObserver(update);
	mutations.observe(el, { childList: true, subtree: true, attributes: true });
	el.addEventListener('scroll', update, { passive: true });
	return () => {
		observer.disconnect();
		mutations.disconnect();
		el.removeEventListener('scroll', update);
	};
}
