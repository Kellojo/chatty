import { describe, expect, it } from 'vitest';
import {
	conceptShapeProblem,
	conceptShapeProblems,
	conceptShapeRegressions,
	MAX_BODY_CHARS,
	MAX_DESCRIPTION_CHARS
} from './limits.js';

describe('conceptShapeProblem', () => {
	it('accepts a short, well-formed note', () => {
		expect(
			conceptShapeProblem({
				description: 'How the user wants UI animations to look.',
				tags: ['animation', 'ui'],
				body: '- Smooth, restrained motion.'
			})
		).toBeNull();
	});

	it('accepts a note without description or tags', () => {
		expect(conceptShapeProblem({ body: 'A fact.' })).toBeNull();
	});

	it('refuses a long description, too many tags and a long body, listing each problem', () => {
		const problem = conceptShapeProblem({
			description: 'x'.repeat(MAX_DESCRIPTION_CHARS + 1),
			tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
			body: 'y'.repeat(MAX_BODY_CHARS + 1)
		});
		expect(problem).toContain('note not saved');
		expect(problem).toContain(`max ${MAX_DESCRIPTION_CHARS}`);
		expect(problem).toContain('7 tags');
		expect(problem).toContain(`max ${MAX_BODY_CHARS}`);
	});

	it('refuses commit hashes in the description', () => {
		expect(conceptShapeProblem({ description: 'Fixed in da8a460c.', body: '' })).toContain(
			'commit hash'
		);
	});

	it('does not mistake ordinary words, numbers or model names for hashes', () => {
		for (const description of [
			'Facade decaf 12345678 coffee.',
			'Runs Qwen3.8-27b on an RTX 4090 and an M5 Max.',
			'Uses bcrypt2 hashing and IPv6 addresses like fe80::1.'
		]) {
			expect(conceptShapeProblem({ description, body: '' }), description).toBeNull();
		}
	});

	it('refuses full-length hashes', () => {
		expect(
			conceptShapeProblem({ description: `Fixed in ${'ab12'.repeat(10)}.`, body: '' })
		).toContain('commit hash');
	});

	it('refuses version, PR and migration tags', () => {
		const problem = conceptShapeProblem({
			tags: ['chatty', 'v0.0.49', 'migration-0093', 'pr-22'],
			body: ''
		});
		expect(problem).toContain('v0.0.49, migration-0093, pr-22');
	});

	it('refuses date and work-session tags but keeps ordinary ones', () => {
		const problem = conceptShapeProblem({
			tags: ['2026', '2026-11', 'q4-2026', 'wave-2026-11-25', 'sprint3', 'phase-2', 'uncommitted'],
			body: ''
		});
		expect(problem).toContain(
			'(2026, 2026-11, q4-2026, wave-2026-11-25, sprint3, phase-2, uncommitted)'
		);
		expect(
			conceptShapeProblem({
				tags: ['session-cookies', 'wave-function', 'sprint-planning', 'v8', '4090', 'm5'],
				body: ''
			})
		).toBeNull();
	});

	it('reports each problem with the field at fault', () => {
		expect(
			conceptShapeProblems({
				description: 'Fixed in da8a460c.',
				tags: ['pr-22'],
				body: 'y'.repeat(MAX_BODY_CHARS + 1)
			}).map((p) => p.field)
		).toEqual(['description', 'tags', 'body']);
	});

	it('measures the body without surrounding whitespace', () => {
		expect(conceptShapeProblem({ body: `\n${'y'.repeat(MAX_BODY_CHARS)}\n\n` })).toBeNull();
	});
});

describe('conceptShapeRegressions', () => {
	const long = 'y'.repeat(MAX_BODY_CHARS + 100);
	const legacy = { description: 'Fixed in da8a460c.', tags: ['pr-22'], body: long };

	it('allows an update that leaves existing problems no worse', () => {
		expect(conceptShapeRegressions(legacy, { ...legacy, body: long.slice(50) })).toEqual([]);
	});

	it('refuses what an update adds or makes worse', () => {
		expect(
			conceptShapeRegressions(legacy, {
				...legacy,
				tags: ['pr-22', 'v1.2'],
				body: `${long} more`
			}).map((p) => p.kind)
		).toEqual(['dating-tags', 'body-length']);
	});

	it('treats every problem of a note that fitted as new', () => {
		expect(conceptShapeRegressions({ body: 'ok' }, legacy)).toHaveLength(3);
	});
});

describe('hash detection', () => {
	it('lets hex-looking words through but not hashes', () => {
		expect(conceptShapeProblem({ description: 'A deadbeef facade12 cafe.', body: '' })).toBeNull();
		expect(conceptShapeProblem({ description: 'See f00687b.', body: '' })).toContain('commit hash');
	});
});

describe('hashes in the body', () => {
	it('allows a couple of hashes but refuses a changelog of them', () => {
		expect(conceptShapeProblem({ body: 'Pinned to f00687b; see also 95da603.' })).toBeNull();
		expect(
			conceptShapeProblem({ body: 'Commits f00687b, 95da603, 434118a and a14d689.' })
		).toContain('body has 4 commit hashes');
	});
});

describe('note structure', () => {
	it('refuses notes named after a work session or date, but not subjects', () => {
		expect(
			conceptShapeProblem({ path: 'projects/chatty-coding-ux-wave-2026-11-25.md', body: '' })
		).toContain('names a work session or date');
		expect(conceptShapeProblem({ title: 'Coding UX (2026-11-25)', body: '' })).toContain('title');
		expect(conceptShapeProblem({ title: 'Phase 2 rollout', body: '' })).toBeNull();
		expect(conceptShapeProblem({ path: 'projects/sprint-3.md', body: '' })).toContain('path');
		expect(
			conceptShapeProblem({
				path: 'projects/session-cookies.md',
				title: 'Session cookies in the Phase One app',
				body: ''
			})
		).toBeNull();
	});

	it('refuses dated update and history sections, but not plain headings', () => {
		const body = '## Status\nok\n\n## Update (2026-11-12)\nmore\n\n### History as of November\nold';
		expect(conceptShapeProblem({ body })).toContain('2 dated update or history section(s)');
		expect(conceptShapeProblem({ body: '## History\nThe house was built in 1902.' })).toBeNull();
	});

	it('refuses frontmatter pasted into the body', () => {
		expect(conceptShapeProblem({ body: '---\ntitle: X\n---\n- fact' })).toContain('frontmatter');
		expect(conceptShapeProblem({ body: '- fact\n\n---\n\n- another' })).toBeNull();
	});

	it('refuses tags that are not lowercase words', () => {
		expect(conceptShapeProblem({ tags: ['Home Assistant', 'ok-tag'], body: '' })).toContain(
			'(Home Assistant)'
		);
	});
});
