import { error } from '@sveltejs/kit';
import { CodingTaskError } from './tasks.js';

/** Runs a coding-task operation, turning CodingTaskError into an HTTP error. */
export async function codingRoute<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof CodingTaskError) error(e.status, { message: e.message });
		throw e;
	}
}
