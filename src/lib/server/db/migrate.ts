import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './index.js';

export function migrate(db: Db, dir = path.join(process.cwd(), 'migrations')): void {
	db.exec(
		'CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)'
	);
	const applied = new Set(
		(db.prepare('SELECT version FROM _migrations').all() as { version: number }[]).map(
			(r) => r.version
		)
	);
	if (!fs.existsSync(dir)) return;
	const files = fs
		.readdirSync(dir)
		.filter((f) => /^\d{4}_.*\.sql$/.test(f))
		.sort();
	for (const file of files) {
		const version = Number(file.slice(0, 4));
		if (applied.has(version)) continue;
		const sql = fs.readFileSync(path.join(dir, file), 'utf8');
		try {
			db.transaction(() => {
				db.exec(sql);
				db.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)').run(
					version,
					Date.now()
				);
			})();
		} catch (err) {
			throw new Error(`Migration ${file} failed and was rolled back`, { cause: err });
		}
	}
}
