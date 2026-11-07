/**
 * Wraps an async task so at most one execution is in flight. Calls made while
 * it runs are folded into a single follow-up execution once it finishes, and
 * every caller's promise settles after the run that covers its call.
 */
export function coalesce(task: () => Promise<void>): () => Promise<void> {
	let inFlight: Promise<void> | null = null;
	let again = false;

	return () => {
		if (inFlight) {
			again = true;
			return inFlight;
		}
		inFlight = (async () => {
			try {
				do {
					again = false;
					try {
						await task();
					} catch (e) {
						// A queued follow-up still runs; only the last failure surfaces.
						if (!again) throw e;
					}
				} while (again);
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	};
}
