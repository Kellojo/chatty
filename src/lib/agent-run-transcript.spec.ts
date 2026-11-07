import { describe, expect, it } from 'vitest';
import { mergeTranscript, transcriptCursor } from './agent-run-transcript.js';
import type { ChatMessage } from './types.js';

function msg(id: string, status: ChatMessage['status'] = 'complete', text = id): ChatMessage {
	return {
		id,
		conversationId: 'c1',
		role: 'assistant',
		parts: [{ type: 'text', text }],
		status,
		error: null,
		usage: null,
		createdAt: 0
	};
}

describe('transcriptCursor', () => {
	it('is null for an empty transcript', () => {
		expect(transcriptCursor([])).toBeNull();
	});

	it('is the last message when nothing is streaming', () => {
		expect(transcriptCursor([msg('a'), msg('b')])).toBe('b');
	});

	it('is the first partial message', () => {
		expect(transcriptCursor([msg('a'), msg('b', 'partial'), msg('c', 'partial')])).toBe('b');
	});
});

describe('mergeTranscript', () => {
	it('replaces everything when the slice is a full transcript', () => {
		const next = [msg('x')];
		expect(mergeTranscript([msg('a'), msg('b')], null, next)).toEqual(next);
	});

	it('replaces the tail from the anchor and keeps earlier messages', () => {
		const current = [msg('a'), msg('b', 'partial', 'hal')];
		const merged = mergeTranscript(current, 'b', [msg('b', 'complete', 'half'), msg('c')]);
		expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
		expect(merged[0]).toBe(current[0]);
		expect(merged[1].status).toBe('complete');
	});

	it('drops tail messages that no longer exist server-side', () => {
		const merged = mergeTranscript([msg('a'), msg('b'), msg('c', 'partial')], 'b', [msg('b')]);
		expect(merged.map((m) => m.id)).toEqual(['a', 'b']);
	});

	it('upserts by id when the anchor is not known locally', () => {
		const merged = mergeTranscript([msg('a'), msg('b', 'partial')], 'zzz', [
			msg('b', 'complete'),
			msg('c')
		]);
		expect(merged.map((m) => [m.id, m.status])).toEqual([
			['a', 'complete'],
			['b', 'complete'],
			['c', 'complete']
		]);
	});
});
