/**
 * Inserts the design playground conversation (src/lib/dev/design-playground.ts)
 * for a user, replacing a previous copy. Optionally copies an existing
 * conversation to that user too, to review a real session's layout.
 *
 *   pnpm seed:playground --email you@example.com
 *   pnpm seed:playground --email you@example.com --sections
 *   pnpm seed:playground --email you@example.com --copy <conversationId>
 *
 * --sections also adds one short chat per section (Markdown, Widgets, …),
 * which is easier to screenshot than the full playground.
 * Options: --db <path> (default: DATABASE_PATH or ./data/ai-chat.db).
 * The app must have run its migrations on that database at least once.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import {
	buildDesignPlayground,
	PLAYGROUND_SECTIONS,
	PLAYGROUND_TITLE
} from '../src/lib/dev/design-playground.ts';

const { values } = parseArgs({
	options: {
		email: { type: 'string' },
		db: { type: 'string' },
		copy: { type: 'string' },
		sections: { type: 'boolean' }
	}
});

if (!values.email) {
	console.error('Usage: pnpm seed:playground --email <user email> [--copy <conversationId>]');
	process.exit(1);
}

const db = new Database(values.db ?? process.env.DATABASE_PATH ?? './data/ai-chat.db');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const user = db.prepare('SELECT id FROM user WHERE email = ?').get(values.email) as
	{ id: string } | undefined;
if (!user) {
	console.error(`No user with email ${values.email}`);
	process.exit(1);
}

const baseUrl = process.env.ORIGIN ?? 'http://localhost:5173';

interface SeedMessage {
	role: string;
	parts: unknown[];
	status?: string;
	error?: string | null;
	usage?: unknown;
}

function textOf(parts: unknown[]): string {
	return parts
		.filter((p): p is { type: 'text'; text: string } => (p as { type?: string }).type === 'text')
		.map((p) => p.text)
		.join('\n');
}

function insertConversation(id: string, title: string, messages: SeedMessage[]): void {
	const start = Date.now() - messages.length * 60_000;
	const insertConv = db.prepare(
		`INSERT INTO conversations (id, user_id, kind, title, mode, created_at, updated_at, last_read_at)
		 VALUES (?, ?, 'chat', ?, 'agent', ?, ?, ?)`
	);
	const insertMsg = db.prepare(
		`INSERT INTO messages (id, conversation_id, role, parts, content_text, status, error, created_at, usage_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const end = start + messages.length * 60_000;
	insertConv.run(id, user!.id, title, start, end, end);
	messages.forEach((m, i) => {
		insertMsg.run(
			randomUUID(),
			id,
			m.role,
			JSON.stringify(m.parts),
			textOf(m.parts),
			m.status ?? 'complete',
			m.error ?? null,
			start + i * 60_000,
			m.usage ? JSON.stringify(m.usage) : null
		);
	});
}

db.transaction(() => {
	// Replace earlier playground copies so the conversation always matches the fixture.
	db.prepare('DELETE FROM conversations WHERE user_id = ? AND (title = ? OR title LIKE ?)').run(
		user.id,
		PLAYGROUND_TITLE,
		`${PLAYGROUND_TITLE} · %`
	);
	const id = randomUUID();
	insertConversation(id, PLAYGROUND_TITLE, buildDesignPlayground());
	console.log(`Design playground: ${baseUrl}/chat/${id}`);

	if (values.sections) {
		for (const section of PLAYGROUND_SECTIONS) {
			const sectionId = randomUUID();
			insertConversation(sectionId, `${PLAYGROUND_TITLE} · ${section.name}`, section.build());
			console.log(`  ${section.name}: ${baseUrl}/chat/${sectionId}`);
		}
	}

	if (values.copy) {
		const source = db.prepare('SELECT title FROM conversations WHERE id = ?').get(values.copy) as
			{ title: string } | undefined;
		if (!source) throw new Error(`No conversation ${values.copy}`);
		const rows = db
			.prepare(
				'SELECT role, parts, status, error, usage_json FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid'
			)
			.all(values.copy) as {
			role: string;
			parts: string;
			status: string;
			error: string | null;
			usage_json: string | null;
		}[];
		const copyId = randomUUID();
		insertConversation(
			copyId,
			`Copy of ${source.title || 'untitled'}`,
			rows.map((r) => ({
				role: r.role,
				parts: JSON.parse(r.parts) as unknown[],
				status: r.status,
				error: r.error,
				usage: r.usage_json ? JSON.parse(r.usage_json) : undefined
			}))
		);
		console.log(`Copy (${rows.length} messages): ${baseUrl}/chat/${copyId}`);
	}
})();
