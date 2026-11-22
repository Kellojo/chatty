/**
 * Runs `cb` once the current DOM state has been painted (two frames later), so
 * a CSS transition switched on in `cb` doesn't animate the change just made.
 * Returns a function that cancels it. Browser-only: call it from an effect or handler.
 */
export function afterPaint(cb: () => void): () => void {
	// The id is swapped for the inner frame's, so cancelling works at either stage.
	let id = requestAnimationFrame(() => {
		id = requestAnimationFrame(cb);
	});
	return () => cancelAnimationFrame(id);
}

/**
 * True once `ready()` has held through a paint; false again whenever it doesn't.
 * Gate transitions on it so an element's first layout appears in place instead
 * of animating in from its unsized state, while later changes still animate.
 */
export function settledAfterPaint(ready: () => boolean): { readonly current: boolean } {
	let settled = $state(false);
	$effect(() => {
		if (!ready()) settled = false;
		else if (!settled) return afterPaint(() => (settled = true));
	});
	return {
		get current() {
			return settled;
		}
	};
}
