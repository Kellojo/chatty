import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../index.js';
import { createConversation } from './conversations.js';
import {
	createMessage,
	deleteMessagesFrom,
	extractText,
	listMessages,
	toPublic,
	updateMessage
} from './messages.js';

let db: Db;
let conversationId: string;

beforeEach(() => {
	db = openDatabase(':memory:');
	db.prepare(
		'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u1\', \'a@b.c\', \'A\', 0, 0, 0, \'user\')'
	).run();
	conversationId = createConversation(db, 'u1').id;
});

describe('messages repo', () => {
	it('createMessage extracts searchable text from parts', () => {
		const m = createMessage(db, {
			conversationId,
			role: 'user',
			parts: [
				{ type: 'text', text: 'hello' },
				{ type: 'file', url: 'x' },
				{ type: 'text', text: 'world' }
			]
		});
		expect(m.content_text).toBe('hello\nworld');
		expect(toPublic(m).parts).toHaveLength(3);
	});

	it('deleteMessagesFrom removes the anchor and later messages of the conversation', () => {
		createMessage(db, { conversationId, role: 'user', parts: [] });
		const anchor = createMessage(db, { conversationId, role: 'assistant', parts: [] });
		createMessage(db, { conversationId, role: 'user', parts: [] });
		const otherConv = createConversation(db, 'u1');
		const other = createMessage(db, { conversationId: otherConv.id, role: 'user', parts: [] });
		expect(deleteMessagesFrom(db, conversationId, anchor.id)).toBe(2);
		const remaining = listMessages(db, conversationId).map((m) => m.role);
		expect(remaining).toEqual(['user']);
		expect(listMessages(db, otherConv.id).map((m) => m.id)).toEqual([other.id]);
	});

	it('deleteMessagesFrom ignores messages from another conversation', () => {
		const otherConv = createConversation(db, 'u1');
		const foreign = createMessage(db, { conversationId: otherConv.id, role: 'user', parts: [] });
		createMessage(db, { conversationId, role: 'user', parts: [] });
		expect(deleteMessagesFrom(db, conversationId, foreign.id)).toBe(0);
		expect(listMessages(db, conversationId)).toHaveLength(1);
	});

	it('updateMessage patches parts, status, and error', () => {
		const m = createMessage(db, { conversationId, role: 'assistant', parts: [] });
		const updated = updateMessage(db, m.id, {
			parts: [{ type: 'text', text: 'partial answer' }],
			status: 'partial',
			error: 'aborted'
		});
		expect(updated!.status).toBe('partial');
		expect(updated!.error).toBe('aborted');
		expect(updated!.content_text).toBe('partial answer');
	});

	it('extractText joins only text parts', () => {
		expect(
			extractText([
				{ type: 'reasoning', text: 'skip' },
				{ type: 'text', text: 'a' },
				{ type: 'text', text: 'b' }
			])
		).toBe('a\nb');
	});
});
