import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';

export type SkillInvocationTrigger = 'auto' | 'manual' | 'agent';

export interface SkillInvocationRow {
	id: string;
	skill_name: string;
	scope: string;
	user_id: string;
	conversation_id: string | null;
	message_id: string | null;
	triggered_by: string;
	created_at: number;
}

export interface RecordSkillInvocationInput {
	skillName: string;
	scope: 'user' | 'shared';
	userId: string;
	conversationId?: string | null;
	messageId?: string | null;
	triggeredBy: SkillInvocationTrigger;
}

export function recordSkillInvocation(
	db: Db,
	input: RecordSkillInvocationInput
): SkillInvocationRow {
	const id = randomUUID();
	db.prepare(
		`INSERT INTO skill_invocations (id, skill_name, scope, user_id, conversation_id, message_id, triggered_by, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		input.skillName,
		input.scope,
		input.userId,
		input.conversationId ?? null,
		input.messageId ?? null,
		input.triggeredBy,
		Date.now()
	);
	return db.prepare('SELECT * FROM skill_invocations WHERE id = ?').get(id) as SkillInvocationRow;
}

export function listSkillInvocations(
	db: Db,
	opts: { userId?: string; skillName?: string; limit?: number }
): SkillInvocationRow[] {
	const where: string[] = [];
	const params: unknown[] = [];
	if (opts.userId !== undefined) {
		where.push('user_id = ?');
		params.push(opts.userId);
	}
	if (opts.skillName !== undefined) {
		where.push('skill_name = ?');
		params.push(opts.skillName);
	}
	const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
	return db
		.prepare(
			`SELECT * FROM skill_invocations
			 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
			 ORDER BY created_at DESC, id DESC LIMIT ?`
		)
		.all(...params, limit) as SkillInvocationRow[];
}
