import { describe, expect, it } from 'vitest';
import type { CodingTaskStatus } from '$lib/coding-environments.js';
import type { Conversation } from '$lib/types.js';
import { DEFAULT_NOTIFICATION_TRIGGERS, type NotificationTriggers } from '$lib/user-settings.js';
import {
	attentionSummary,
	badgedFaviconSvg,
	codingStatusSnapshot,
	composeTitle,
	newlyNeedingYou,
	noticeForEvent
} from './rules.js';

function conv(id: string, overrides: Partial<Conversation> = {}): Conversation {
	return {
		id,
		kind: 'chat',
		title: `Chat ${id}`,
		mode: 'chat',
		providerId: null,
		modelId: null,
		systemPrompt: null,
		memoryEnabled: false,
		maxSteps: null,
		temperature: null,
		maxTokens: null,
		pinned: false,
		agentId: null,
		settledAt: null,
		settledReason: null,
		coding: null,
		createdAt: 0,
		updatedAt: 0,
		...overrides
	};
}

function coding(id: string, status: CodingTaskStatus, overrides: Partial<Conversation> = {}) {
	return conv(id, {
		coding: { projectTitle: 'repo', status, runStartedAt: null, diff: null, pullRequest: null },
		...overrides
	});
}

function ctx(conversations: Conversation[], triggers: Partial<NotificationTriggers> = {}) {
	return {
		triggers: { ...DEFAULT_NOTIFICATION_TRIGGERS, ...triggers },
		conversation: (id: string) => conversations.find((c) => c.id === id)
	};
}

describe('noticeForEvent', () => {
	it('raises a reply notice for a finished chat reply', () => {
		const notice = noticeForEvent(
			{ type: 'chat.message_completed', conversationId: 'a' },
			ctx([conv('a')])
		);
		expect(notice).toMatchObject({
			kind: 'reply',
			title: 'Chat a',
			url: '/chat/a',
			tag: 'chat:a',
			conversationId: 'a'
		});
	});

	it('falls back to a generic title for unknown or untitled chats', () => {
		expect(
			noticeForEvent({ type: 'chat.message_completed', conversationId: 'x' }, ctx([]))?.title
		).toBe('New chat');
		expect(
			noticeForEvent(
				{ type: 'chat.message_completed', conversationId: 'a' },
				ctx([conv('a', { title: '' })])
			)?.title
		).toBe('New chat');
	});

	it('leaves coding task replies to coding.thread.finished', () => {
		expect(
			noticeForEvent(
				{ type: 'chat.message_completed', conversationId: 'c' },
				ctx([coding('c', 'idle')])
			)
		).toBeNull();
	});

	it('respects the replies trigger', () => {
		expect(
			noticeForEvent(
				{ type: 'chat.message_completed', conversationId: 'a' },
				ctx([conv('a')], { replies: false })
			)
		).toBeNull();
	});

	it('maps coding run outcomes to finished/failed and skips interruptions', () => {
		const base = { type: 'coding.thread.finished', conversationId: 'c', branch: null } as const;
		const c = ctx([coding('c', 'idle')]);
		expect(noticeForEvent({ ...base, status: 'completed', prUrl: null }, c)).toMatchObject({
			kind: 'finished',
			body: 'Coding task finished'
		});
		expect(noticeForEvent({ ...base, status: 'completed', prUrl: 'https://x' }, c)?.body).toBe(
			'Coding task finished, pull request ready'
		);
		expect(noticeForEvent({ ...base, status: 'failed', prUrl: null }, c)?.kind).toBe('failed');
		expect(noticeForEvent({ ...base, status: 'interrupted', prUrl: null }, c)).toBeNull();
		expect(
			noticeForEvent(
				{ ...base, status: 'completed', prUrl: null },
				ctx([], { codingFinished: false })
			)
		).toBeNull();
	});

	it('only reports successful agent runs when opted in, failures by default', () => {
		const event = (status: 'success' | 'failed') =>
			({ type: 'agent.run.finished', agentId: 'ag', runId: 'r1', status }) as const;
		expect(noticeForEvent(event('success'), ctx([]))).toBeNull();
		expect(noticeForEvent(event('success'), ctx([], { agentRuns: true }))).toMatchObject({
			kind: 'finished',
			url: '/agents/ag/runs/r1',
			agentId: 'ag'
		});
		expect(noticeForEvent(event('failed'), ctx([]))?.kind).toBe('failed');
		expect(noticeForEvent(event('failed'), ctx([], { failures: false }))).toBeNull();
	});

	it('ignores unrelated events', () => {
		expect(noticeForEvent({ type: 'skills.changed' }, ctx([]))).toBeNull();
	});
});

describe('newlyNeedingYou', () => {
	it('reports tasks that just moved into awaiting_input or appeared waiting', () => {
		const before = codingStatusSnapshot([coding('a', 'running'), coding('b', 'awaiting_input')]);
		const after = [
			coding('a', 'awaiting_input'),
			coding('b', 'awaiting_input'),
			coding('new', 'awaiting_input')
		];
		expect(newlyNeedingYou(before, after).map((c) => c.id)).toEqual(['a', 'new']);
	});

	it('ignores settled tasks', () => {
		const before = codingStatusSnapshot([coding('a', 'running')]);
		expect(newlyNeedingYou(before, [coding('a', 'awaiting_input', { settledAt: 1 })])).toEqual([]);
	});
});

describe('attentionSummary', () => {
	it('counts unread chats and waiting tasks, excluding the open and settled ones', () => {
		const conversations = [
			conv('a'),
			conv('b'),
			conv('settled', { settledAt: 1 }),
			coding('t', 'awaiting_input'),
			coding('busy', 'running')
		];
		expect(attentionSummary(conversations, ['a', 'b', 'settled'], 'b')).toEqual({
			count: 2,
			level: 'needs-you'
		});
		expect(attentionSummary([conv('a')], ['a'], null)).toEqual({ count: 1, level: 'unread' });
		expect(attentionSummary([conv('a')], [], null)).toEqual({ count: 0, level: 'none' });
	});
});

describe('composeTitle', () => {
	it('prefixes the count and alternates with the flash label', () => {
		expect(composeTitle('Chatty', 0, null)).toBe('Chatty');
		expect(composeTitle('Chatty', 3, null)).toBe('(3) Chatty');
		expect(composeTitle('Chatty', 3, { label: 'New reply', on: true })).toBe('● New reply');
		expect(composeTitle('Chatty', 3, { label: 'New reply', on: false })).toBe('(3) Chatty');
	});
});

describe('badgedFaviconSvg', () => {
	it('adds a dot just before the closing tag', () => {
		const out = badgedFaviconSvg('<svg><rect/></svg>', '#f00');
		expect(out).toMatch(/^<svg><rect\/><circle [^>]*fill="#f00"[^>]*\/><\/svg>$/);
	});
});
