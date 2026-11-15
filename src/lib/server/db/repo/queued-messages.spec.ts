import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../index.js';
import { createConversation, softDeleteConversation } from './conversations.js';
import {
	enqueueMessage,
	getMessageQueue,
	isQueuePaused,
	listQueuedConversations,
	removeQueuedMessage,
	requeueFirst,
	setQueuePaused,
	takeFirstQueuedMessage
} from './queued-messages.js';

let db: Db;
let c1: string;
let c2: string;

const file = {
	type: 'file' as const,
	url: '/api/conversations/x/attachments/a1',
	mediaType: 'image/png',
	filename: 'a.png'
};

beforeEach(() => {
	db = openDatabase(':memory:');
	db.prepare(
		'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u1\', \'a@b.c\', \'A\', 0, 0, 0, \'user\')'
	).run();
	c1 = createConversation(db, 'u1').id;
	c2 = createConversation(db, 'u1').id;
});

describe('queued messages repo', () => {
	it('keeps messages in order, per conversation, with their files', () => {
		enqueueMessage(db, c1, { text: 'first', files: [file] });
		enqueueMessage(db, c1, { text: 'second', files: [] });
		enqueueMessage(db, c2, { text: 'other', files: [] });
		const queue = getMessageQueue(db, c1);
		expect(queue.items.map((m) => m.text)).toEqual(['first', 'second']);
		expect(queue.items[0].files).toEqual([file]);
		expect(queue.paused).toBe(false);
		expect(getMessageQueue(db, c2).items.map((m) => m.text)).toEqual(['other']);
	});

	it('takes the first message and puts it back at the front', () => {
		enqueueMessage(db, c1, { text: 'first', files: [] });
		enqueueMessage(db, c1, { text: 'second', files: [] });
		const first = takeFirstQueuedMessage(db, c1)!;
		expect(first.text).toBe('first');
		expect(getMessageQueue(db, c1).items.map((m) => m.text)).toEqual(['second']);
		requeueFirst(db, first);
		expect(getMessageQueue(db, c1).items.map((m) => m.text)).toEqual(['first', 'second']);
		expect(takeFirstQueuedMessage(db, c2)).toBeUndefined();
	});

	it('removes a message once', () => {
		const row = enqueueMessage(db, c1, { text: 'first', files: [] });
		expect(removeQueuedMessage(db, c2, row.id)).toBeUndefined();
		expect(removeQueuedMessage(db, c1, row.id)?.text).toBe('first');
		expect(removeQueuedMessage(db, c1, row.id)).toBeUndefined();
	});

	it('tracks whether a queue is paused', () => {
		setQueuePaused(db, c1, true);
		expect(isQueuePaused(db, c1)).toBe(true);
		expect(isQueuePaused(db, c2)).toBe(false);
		setQueuePaused(db, c1, false);
		expect(isQueuePaused(db, c1)).toBe(false);
	});

	it('lists conversations with waiting messages and their owners', () => {
		enqueueMessage(db, c1, { text: 'a', files: [] });
		enqueueMessage(db, c1, { text: 'b', files: [] });
		expect(listQueuedConversations(db)).toEqual([{ conversationId: c1, userId: 'u1' }]);
		softDeleteConversation(db, 'u1', c1);
		expect(listQueuedConversations(db)).toEqual([]);
	});
});
