import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PickerModelGroup } from '$lib/types.js';
import { pickerModelGroups, resetModelCatalog, syncModelCatalog } from './model-catalog.svelte.js';

const group = (modelId: string): PickerModelGroup => ({
	provider: { id: 'p', name: 'Provider', type: 'anthropic', baseUrl: null },
	models: [{ providerId: 'p', modelId, displayName: modelId, capabilities: ['chat'] }]
});

describe('model catalog cache', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		resetModelCatalog();
	});

	it('keeps the list a full page load came with for later loads of that version', () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		syncModelCatalog({ version: 'v1', count: 1, groups: [group('a')] });
		const later = { version: 'v1', count: 1 };
		syncModelCatalog(later);
		expect(pickerModelGroups(later)).toEqual([group('a')]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('fetches a new version once, showing the old list meanwhile', async () => {
		syncModelCatalog({ version: 'v1', count: 1, groups: [group('a')] });
		let respond: (res: Response) => void = () => {};
		const fetchSpy = vi.fn(() => new Promise<Response>((r) => (respond = r)));
		vi.stubGlobal('fetch', fetchSpy);
		const next = { version: 'v2', count: 1 };
		syncModelCatalog(next);
		syncModelCatalog(next);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy).toHaveBeenCalledWith('/api/models/catalog?v=v2');
		expect(pickerModelGroups(next)).toEqual([group('a')]);
		respond(new Response(JSON.stringify({ version: 'v2', groups: [group('b')] })));
		await vi.waitFor(() => expect(pickerModelGroups(next)).toEqual([group('b')]));
	});

	it('tries again after a failed fetch', async () => {
		const fetchSpy = vi.fn(async () => new Response('nope', { status: 500 }));
		vi.stubGlobal('fetch', fetchSpy);
		const info = { version: 'v3', count: 1 };
		syncModelCatalog(info);
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
		await new Promise((r) => setTimeout(r, 0));
		expect(pickerModelGroups(info)).toEqual([]);
		syncModelCatalog(info);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});
