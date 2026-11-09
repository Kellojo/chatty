import { describe, expect, it } from 'vitest';
import { clipboardFiles } from './clipboard-files.js';

const NOW = Date.UTC(2026, 10, 9, 14, 30, 5);

describe('clipboardFiles', () => {
	it('returns copied files with their names', () => {
		const doc = new File(['x'], 'report.pdf', { type: 'application/pdf' });
		const out = clipboardFiles({ types: ['Files'], files: [doc] }, NOW);
		expect(out).toEqual([doc]);
	});

	it('names pasted screenshots and images', () => {
		const shot = new File(['x'], 'image.png', { type: 'image/png' });
		const [out] = clipboardFiles({ types: ['text/html', 'Files'], files: [shot] }, NOW);
		expect(out.name).toBe('pasted-2026-11-09-14-30-05.png');
		expect(out.type).toBe('image/png');
		const unnamed = new File(['x'], '', { type: 'image/jpeg' });
		const both = clipboardFiles({ types: ['Files'], files: [unnamed, shot] }, NOW);
		expect(both.map((f) => f.name)).toEqual([
			'pasted-2026-11-09-14-30-05-1.jpg',
			'pasted-2026-11-09-14-30-05-2.png'
		]);
	});

	it('leaves text pastes alone, even with a picture of the selection', () => {
		const picture = new File(['x'], 'image.png', { type: 'image/png' });
		expect(clipboardFiles({ types: ['text/plain', 'Files'], files: [picture] }, NOW)).toEqual([]);
		expect(clipboardFiles({ types: ['text/plain'], files: [] }, NOW)).toEqual([]);
		expect(clipboardFiles(null, NOW)).toEqual([]);
	});
});
