// KaTeX's stylesheet (and its fonts) is only needed once a message has math,
// so it's fetched on demand instead of shipping with every chat page.

// Display math, \( \) / \[ \] delimiters, or inline $…$ that doesn't start or
// end on a space (so "$5 and $10" doesn't count). False positives only cost a
// stylesheet load.
const MATH = /\$\$|\\\(|\\\[|\$[^\s$]\$|\$[^\s$][^$\n]*[^\s$\\]\$/;

export function mayContainMath(text: string): boolean {
	return MATH.test(text);
}

let loading: Promise<unknown> | null = null;

/** Loads the KaTeX stylesheet once; later calls are no-ops. */
export function loadKatexCss(): void {
	loading ??= import('katex/dist/katex.min.css').catch(() => {
		loading = null;
	});
}
