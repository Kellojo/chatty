export interface LimitedBody {
	body: Buffer;
	/** True when the response had more than `limit` bytes; `body` holds the first `limit`. */
	truncated: boolean;
}

/**
 * Read a response body with a running byte counter, cancelling the stream as
 * soon as it exceeds `limit` — unlike `arrayBuffer()`, a huge or endless body
 * can't be buffered whole into memory.
 */
export async function readBodyLimited(res: Response, limit: number): Promise<LimitedBody> {
	if (!res.body) return { body: Buffer.alloc(0), truncated: false };
	const reader = res.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const remaining = limit - total;
			if (value.byteLength > remaining) {
				if (remaining > 0) chunks.push(Buffer.from(value.buffer, value.byteOffset, remaining));
				total = limit;
				truncated = true;
				await reader.cancel().catch(() => {});
				break;
			}
			chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	return { body: Buffer.concat(chunks, total), truncated };
}
