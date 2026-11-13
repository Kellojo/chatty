import { randomUUID } from 'node:crypto';
import {
	SKILL_TRIGGERS,
	skillUsageKey,
	type SkillScope,
	type SkillTrigger,
	type SkillUsage,
	type SkillUsageDetail,
	type SkillUsageStats
} from '$lib/skill-types.js';
import type { Db } from '../index.js';
import { usageDay } from './mcp-tool-usage.js';

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
	at?: number;
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
		input.at ?? Date.now()
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

const DAY_MS = 24 * 60 * 60_000;
/** How far back the skills page looks. */
export const SKILL_USAGE_WINDOW_DAYS = 30;

/** Whose uses someone may count: always their own; an admin also everyone's uses of shared skills. */
export interface SkillUsageViewer {
	userId: string;
	isAdmin: boolean;
}

/** Rows the viewer may count. Other users' private skills are never theirs to see, admin or not. */
const VISIBLE = `((scope = 'user' AND user_id = @me) OR (scope = 'shared' AND (@all = 1 OR user_id = @me)))`;
const DAY_EXPR = `strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')`;

function viewerParams(viewer: SkillUsageViewer) {
	return { me: viewer.userId, all: viewer.isAdmin ? 1 : 0 };
}

/** Start (ms, inclusive) of the window of whole UTC days ending on the day of `now`. */
function windowStartMs(now: number, days: number): number {
	return Date.parse(usageDay(now - (days - 1) * DAY_MS));
}

function windowDays(now: number, days: number): string[] {
	return Array.from({ length: days }, (_, i) => usageDay(now - (days - 1 - i) * DAY_MS));
}

const zeroTriggers = (): Record<SkillTrigger, number> => ({ manual: 0, auto: 0, agent: 0 });
const isTrigger = (t: string): t is SkillTrigger => (SKILL_TRIGGERS as string[]).includes(t);

/** Per-skill totals over the window, keyed by `skillUsageKey`. `lastUsedAt` looks beyond the window. */
export function summarizeSkillUsage(
	db: Db,
	viewer: SkillUsageViewer,
	now = Date.now(),
	days = SKILL_USAGE_WINDOW_DAYS
): Record<string, SkillUsage> {
	const rows = db
		.prepare(
			`SELECT scope, skill_name,
			        SUM(CASE WHEN created_at >= @since THEN 1 ELSE 0 END) AS uses,
			        COUNT(DISTINCT CASE WHEN created_at >= @since THEN user_id END) AS users,
			        MAX(created_at) AS last_used_at
			 FROM skill_invocations WHERE ${VISIBLE}
			 GROUP BY scope, skill_name`
		)
		.all({ ...viewerParams(viewer), since: windowStartMs(now, days) }) as {
		scope: string;
		skill_name: string;
		uses: number;
		users: number;
		last_used_at: number;
	}[];
	const out: Record<string, SkillUsage> = {};
	for (const r of rows) {
		out[skillUsageKey({ scope: r.scope, name: r.skill_name })] = {
			uses: r.uses,
			users: r.users,
			lastUsedAt: r.last_used_at
		};
	}
	return out;
}

/** Every visible skill's uses over `days`: per skill, and per day split by skill (oldest first). */
export function getSkillUsageStats(
	db: Db,
	viewer: SkillUsageViewer,
	days: number,
	now = Date.now()
): SkillUsageStats {
	const params = { ...viewerParams(viewer), since: windowStartMs(now, days) };
	const where = `${VISIBLE} AND created_at >= @since`;
	const rows = db
		.prepare(
			`SELECT scope, skill_name, triggered_by, COUNT(*) AS uses,
			        MAX(created_at) AS last_used_at
			 FROM skill_invocations WHERE ${where}
			 GROUP BY scope, skill_name, triggered_by`
		)
		.all(params) as {
		scope: SkillScope;
		skill_name: string;
		triggered_by: string;
		uses: number;
		last_used_at: number;
	}[];
	const users = new Map(
		(
			db
				.prepare(
					`SELECT scope, skill_name, COUNT(DISTINCT user_id) AS users
					 FROM skill_invocations WHERE ${where} GROUP BY scope, skill_name`
				)
				.all(params) as { scope: string; skill_name: string; users: number }[]
		).map((r) => [skillUsageKey({ scope: r.scope, name: r.skill_name }), r.users])
	);
	const skills = new Map<string, SkillUsageStats['skills'][number]>();
	for (const r of rows) {
		const key = skillUsageKey({ scope: r.scope, name: r.skill_name });
		let s = skills.get(key);
		if (!s) {
			s = {
				key,
				scope: r.scope,
				name: r.skill_name,
				uses: 0,
				users: users.get(key) ?? 0,
				lastUsedAt: 0,
				...zeroTriggers()
			};
			skills.set(key, s);
		}
		s.uses += r.uses;
		if (isTrigger(r.triggered_by)) s[r.triggered_by] += r.uses;
		s.lastUsedAt = Math.max(s.lastUsedAt, r.last_used_at);
	}

	const daily = windowDays(now, days).map((day) => ({ day, uses: {} as Record<string, number> }));
	const byDay = new Map(daily.map((d) => [d.day, d]));
	const cells = db
		.prepare(
			`SELECT ${DAY_EXPR} AS day, scope, skill_name, COUNT(*) AS uses
			 FROM skill_invocations WHERE ${where} GROUP BY day, scope, skill_name`
		)
		.all(params) as { day: string; scope: string; skill_name: string; uses: number }[];
	for (const c of cells) {
		const d = byDay.get(c.day);
		if (d) d.uses[skillUsageKey({ scope: c.scope, name: c.skill_name })] = c.uses;
	}

	const total = db
		.prepare(`SELECT COUNT(DISTINCT user_id) AS users FROM skill_invocations WHERE ${where}`)
		.get(params) as { users: number };
	return {
		days,
		users: total.users,
		skills: [...skills.values()].sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)),
		daily
	};
}

/** One skill's uses over the window: per trigger, and per day split by trigger (every day, oldest first). */
export function getSkillUsage(
	db: Db,
	viewer: SkillUsageViewer,
	skill: { scope: SkillScope; name: string },
	now = Date.now(),
	days = SKILL_USAGE_WINDOW_DAYS
): SkillUsageDetail {
	const params = {
		...viewerParams(viewer),
		since: windowStartMs(now, days),
		scope: skill.scope,
		name: skill.name
	};
	const where = `${VISIBLE} AND scope = @scope AND skill_name = @name AND created_at >= @since`;
	const cells = db
		.prepare(
			`SELECT ${DAY_EXPR} AS day, triggered_by, COUNT(*) AS uses
			 FROM skill_invocations WHERE ${where} GROUP BY day, triggered_by`
		)
		.all(params) as { day: string; triggered_by: string; uses: number }[];
	const daily = windowDays(now, days).map((day) => ({ day, ...zeroTriggers() }));
	const byDay = new Map(daily.map((d) => [d.day, d]));
	const uses = zeroTriggers();
	for (const c of cells) {
		if (!isTrigger(c.triggered_by)) continue;
		uses[c.triggered_by] += c.uses;
		const d = byDay.get(c.day);
		if (d) d[c.triggered_by] += c.uses;
	}
	const { users } = db
		.prepare(`SELECT COUNT(DISTINCT user_id) AS users FROM skill_invocations WHERE ${where}`)
		.get(params) as { users: number };
	return { days, users, uses, daily };
}
