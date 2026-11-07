import { getContext, setContext } from 'svelte';
import type { CodingModelRef } from '$lib/coding-environments.js';

/** Favourites key of a coding-agent model; prefixed so it never clashes with chat models. */
export const codingFavoriteKey = (m: CodingModelRef) => `t3:${m.providerInstanceId}/${m.model}`;

/**
 * The user's starred models (encoded `providerId/modelId` refs), shared by
 * every model picker in the app and persisted as a user setting.
 */
export class FavoriteModels {
	#refs = $state<string[]>([]);

	constructor(initial: string[]) {
		this.#refs = [...initial];
	}

	get refs(): readonly string[] {
		return this.#refs;
	}

	has(ref: string): boolean {
		return this.#refs.includes(ref);
	}

	toggle(ref: string) {
		const previous = this.#refs;
		this.#refs = this.has(ref) ? previous.filter((r) => r !== ref) : [...previous, ref];
		void this.#save(previous);
	}

	async #save(previous: string[]) {
		try {
			const res = await fetch('/api/user/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ favoriteModels: this.#refs })
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
		} catch {
			this.#refs = previous;
		}
	}
}

const KEY = Symbol('favorite-models');

export function setFavoriteModels(favorites: FavoriteModels) {
	setContext(KEY, favorites);
}

export function getFavoriteModels(): FavoriteModels | undefined {
	return getContext<FavoriteModels | undefined>(KEY);
}
