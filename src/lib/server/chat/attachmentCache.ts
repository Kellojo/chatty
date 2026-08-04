import { createLogger } from '../logger.js';

const log = createLogger('attachment-cache');

export const CACHE_MAX_BYTES = 100 * 1024 * 1024; // 100MB hard cap (constant)

interface CacheEntry {
	dataUri: string;
	size: number;
}

class LruCache {
	private cache = new Map<string, CacheEntry>();
	#totalBytes = 0;

	get(id: string): string | undefined {
		const entry = this.cache.get(id);
		if (!entry) return undefined;
		this.cache.delete(id);
		this.cache.set(id, entry);
		return entry.dataUri;
	}

	set(id: string, dataUri: string): void {
		const existing = this.cache.get(id);
		const size = Buffer.byteLength(dataUri, 'utf8');

		if (existing) {
			this.cache.delete(id);
			this.#totalBytes -= existing.size;
		}

		while (this.#totalBytes + size > CACHE_MAX_BYTES) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey === undefined) break;
			const entry = this.cache.get(firstKey)!;
			this.cache.delete(firstKey);
			this.#totalBytes -= entry.size;
		}

		this.cache.set(id, { dataUri, size });
		this.#totalBytes += size;
		log.info('Cache hit', { id, size: `${size / 1024}KB`, totalBytes: this.totalBytes() });
	}

	clear(): void {
		this.cache.clear();
		this.#totalBytes = 0;
	}

	totalBytes(): number {
		return this.#totalBytes;
	}
}

export const attachmentCache = new LruCache();
