import { describe, expect, it } from 'vitest';
import { hostContextMessage, htmlRenderHeightAt, readHtmlRender } from './html-render.js';
import { groupParts } from './components/app/timeline.js';

const part = (output: unknown, state = 'output-available') => ({
	type: 'dynamic-tool',
	toolName: 'mcp__t3-code__html_render',
	state,
	input: { title: 'Input title', height: 300, html: '<p>x</p>' },
	output
});

const ref = {
	attachmentId: 'abc-123-html',
	title: 'Overview',
	height: 150,
	heights: [
		[640, 124],
		[320, 200],
		[1000, 90]
	]
};

describe('readHtmlRender', () => {
	it('reads a published page', () => {
		expect(readHtmlRender(part({ htmlRender: ref }))).toEqual({
			title: 'Overview',
			height: 150,
			heights: [
				[320, 200],
				[640, 124],
				[1000, 90]
			],
			attachmentId: 'abc-123-html'
		});
		expect(readHtmlRender(part(JSON.stringify({ htmlRender: ref })))?.title).toBe('Overview');
	});

	it('ignores refused, unfinished and other tool calls', () => {
		expect(readHtmlRender(part('Error: uses vh units'))).toBeNull();
		expect(readHtmlRender(part(undefined, 'input-available'))).toBeNull();
		expect(readHtmlRender({ ...part({ htmlRender: ref }), toolName: 'html_preview' })).toBeNull();
		expect(readHtmlRender({ type: 'text' })).toBeNull();
	});

	it('drops attachment ids that could leave the path', () => {
		const out = readHtmlRender(part({ htmlRender: { ...ref, attachmentId: '../x' } }));
		expect(out?.attachmentId).toBeNull();
	});

	it('reads a page whose input T3 shortened, through its stored copy only', () => {
		const shortened = {
			...part({ htmlRender: ref }),
			input: { summary: '{"html":…', truncated: true }
		};
		expect(readHtmlRender(shortened)?.attachmentId).toBe('abc-123-html');
		const noCopy = { ...shortened, output: { htmlRender: { ...ref, attachmentId: undefined } } };
		expect(readHtmlRender(noCopy)).toBeNull();
	});
});

describe('htmlRenderHeightAt', () => {
	it('uses the widest measurement that fits', () => {
		const r = readHtmlRender(part({ htmlRender: ref }))!;
		expect(htmlRenderHeightAt(r, 700)).toBe(124);
		expect(htmlRenderHeightAt(r, 200)).toBe(200);
		expect(htmlRenderHeightAt(r, 0)).toBe(150);
	});
});

describe('hostContextMessage', () => {
	it('strips characters that could break out of a declaration', () => {
		const msg = hostContextMessage('dark', {
			'--card': 'red;}</style><script>',
			'bad name': 'x'
		});
		expect(msg.params.styles.variables).toEqual({ '--card': 'red/stylescript' });
	});
});

describe('groupParts', () => {
	it('shows published pages inline instead of folding them into activity', () => {
		const tool = { type: 'dynamic-tool', toolName: 'Bash', state: 'output-available' };
		const blocks = groupParts([tool, part({ htmlRender: ref }), tool]);
		expect(blocks.map((b) => b.type)).toEqual(['activity', 'content', 'activity']);
	});
});
