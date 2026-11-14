import type { Db } from '../index.js';

export interface AaModel {
	id: string;
	slug: string;
	name: string;
	creator: string | null;
	intelligenceIndex: number | null;
	releaseDate: string | null;
}

interface AaModelRow {
	id: string;
	slug: string;
	name: string;
	creator: string | null;
	intelligence_index: number | null;
	release_date: string | null;
	fetched_at: number;
}

export function listAaModels(db: Db): AaModel[] {
	const rows = db.prepare('SELECT * FROM aa_models ORDER BY slug').all() as AaModelRow[];
	return rows.map((r) => ({
		id: r.id,
		slug: r.slug,
		name: r.name,
		creator: r.creator,
		intelligenceIndex: r.intelligence_index,
		releaseDate: r.release_date
	}));
}

export function countAaModels(db: Db): number {
	return (db.prepare('SELECT COUNT(*) AS n FROM aa_models').get() as { n: number }).n;
}

/** Swaps the whole cache in one transaction, so readers never see a half-written list. */
export function replaceAaModels(db: Db, models: AaModel[], fetchedAt: number = Date.now()): void {
	const insert = db.prepare(
		`INSERT INTO aa_models (id, slug, name, creator, intelligence_index, release_date, fetched_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	);
	db.transaction(() => {
		db.prepare('DELETE FROM aa_models').run();
		for (const m of models) {
			insert.run(m.id, m.slug, m.name, m.creator, m.intelligenceIndex, m.releaseDate, fetchedAt);
		}
	})();
}

export function clearAaModels(db: Db): void {
	db.prepare('DELETE FROM aa_models').run();
}
