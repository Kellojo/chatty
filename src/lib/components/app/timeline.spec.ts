import { describe, expect, it } from 'vitest';
import { describeTool, toolFailed } from '$lib/tool-meta.js';
import { groupParts, hasVisibleContent, summarizeActivity, type PartLike } from './timeline.js';

const text = (t: string): PartLike => ({ type: 'text', text: t }) as PartLike;
const reasoning = (): PartLike => ({ type: 'reasoning' });
const tool = (toolName: string, input: unknown = {}, output: unknown = {}): PartLike => ({
	type: 'dynamic-tool',
	toolName,
	input,
	output,
	state: 'output-available'
});

describe('groupParts', () => {
	it('folds consecutive tool calls and reasoning into one activity block', () => {
		const blocks = groupParts([
			reasoning(),
			tool('run_command'),
			tool('fs_read'),
			text('done'),
			tool('fetch')
		]);
		expect(blocks.map((b) => b.type)).toEqual(['activity', 'content', 'activity']);
		expect(blocks[0].type === 'activity' && blocks[0].items.map((i) => i.index)).toEqual([0, 1, 2]);
	});

	it('keeps keys stable while a message streams', () => {
		const first = groupParts([tool('a'), text('x')]).map((b) => b.key);
		const later = groupParts([tool('a'), text('x'), tool('b')]).map((b) => b.key);
		expect(later.slice(0, first.length)).toEqual(first);
	});
});

describe('summarizeActivity', () => {
	it('lists specific work first and generic tools last', () => {
		const block = groupParts([tool('list_recipes'), tool('health_check'), tool('run_command')])[0];
		if (block.type !== 'activity') throw new Error('expected activity');
		expect(summarizeActivity(block.items).title).toBe('Ran a command, used 2 tools');
	});

	it('counts steps by kind', () => {
		const items = groupParts([
			reasoning(),
			tool('run_command', { command: 'ls' }),
			tool('run_command', { command: 'pwd' }),
			tool('edit_files', { files: ['a.ts', 'b.ts', 'c.ts'] }),
			tool('run_command', { command: 'git diff' }, { exitCode: 1 })
		]);
		const block = items[0];
		if (block.type !== 'activity') throw new Error('expected activity');
		expect(summarizeActivity(block.items)).toEqual({
			title: 'Edited 3 files, ran 3 commands',
			steps: 4,
			failed: 1
		});
	});

	it('names reasoning-only runs', () => {
		const block = groupParts([reasoning(), reasoning()])[0];
		if (block.type !== 'activity') throw new Error('expected activity');
		expect(summarizeActivity(block.items).title).toBe('Thought');
	});
});

describe('describeTool', () => {
	it('labels builtin tools and picks the detail field', () => {
		expect(describeTool('fs_read', { path: '/home/me/projects/app/README.md' })).toEqual({
			label: 'Read file',
			detail: '…/app/README.md',
			kind: 'read',
			server: 'fs',
			prose: false
		});
	});

	it('sets step titles in prose but commands in code', () => {
		expect(describeTool('run_command', { command: 'Preparing workspace' })).toMatchObject({
			label: 'Preparing workspace',
			detail: null
		});
		expect(describeTool('run_command', { command: 'pnpm check' }).prose).toBe(false);
		expect(describeTool('run_command', { command: 'Get-ChildItem src' }).prose).toBe(false);
	});

	it('shows a coding-agent notice as prose', () => {
		expect(describeTool('notice', { text: 'Command "pnpm dev" was stopped' })).toMatchObject({
			label: 'Notice',
			detail: 'Command "pnpm dev" was stopped',
			prose: true
		});
	});

	it('strips a leading cd from commands', () => {
		expect(describeTool('run_command', { command: 'cd /c/repo && pnpm check' }).detail).toBe(
			'pnpm check'
		);
	});

	it('reads coding-agent titles like "Read C:/path/file.ts"', () => {
		expect(describeTool('Read C:\\repo\\src\\lib\\app.ts', { kind: 'dynamic_tool' })).toMatchObject(
			{
				label: 'Read',
				detail: '…/lib/app.ts',
				kind: 'read'
			}
		);
		expect(describeTool('Round 1 review', { kind: 'subagent' })).toMatchObject({
			label: 'Subagent',
			detail: 'Round 1 review'
		});
	});

	it("names the coding agent's own tools and MCP tools", () => {
		expect(describeTool('Read', { file_path: 'C:\\repo\\src\\lib\\a.ts' })).toMatchObject({
			label: 'Read',
			detail: '…/lib/a.ts',
			kind: 'read'
		});
		expect(describeTool('Bash', { command: 'cd /repo && pnpm lint' }).detail).toBe('pnpm lint');
		expect(describeTool('mcp__t3-code__preview_open', { url: 'http://x' })).toMatchObject({
			label: 'Preview open',
			detail: 'url: http://x'
		});
		expect(describeTool('mcp__github__list_prs', {}).detail).toBe('github');
		expect(
			describeTool('TodoWrite', {
				todos: [{ status: 'completed' }, { status: 'pending' }]
			}).detail
		).toBe('1 of 2 done');
		expect(describeTool('checkpoint', { files: ['a.ts', 'b/c.ts'] }).detail).toBe('a.ts, c.ts');
		expect(describeTool('subagent', { description: 'Round 1 review' })).toMatchObject({
			label: 'Subagent',
			detail: 'Round 1 review',
			prose: true
		});
	});

	it('humanizes unknown tools and shows short arguments', () => {
		expect(describeTool('list_recipes', { search: 'pasta' })).toEqual({
			label: 'List recipes',
			detail: 'search: pasta',
			kind: 'tool',
			server: null,
			prose: false
		});
	});
});

describe('toolFailed', () => {
	it('detects errors, MCP isError results and non-zero exit codes', () => {
		expect(toolFailed({ state: 'output-error' })).toBe(true);
		expect(toolFailed({ state: 'output-available', output: { isError: true } })).toBe(true);
		expect(toolFailed({ state: 'output-available', output: { exitCode: 2 } })).toBe(true);
		expect(toolFailed({ state: 'output-available', output: { exitCode: 0 } })).toBe(false);
		expect(toolFailed({ state: 'input-available' })).toBe(false);
	});
});

describe('detailCoversInput', () => {
	it('is true only when the row shows the whole input', async () => {
		const { detailCoversInput } = await import('$lib/tool-meta.js');
		expect(detailCoversInput({ command: 'pnpm build' }, 'pnpm build')).toBe(true);
		expect(detailCoversInput({ a: 2, b: 3 }, 'a: 2 · b: 3')).toBe(true);
		expect(detailCoversInput({ command: 'cd /repo && pnpm build' }, 'pnpm build')).toBe(false);
		expect(detailCoversInput({ path: '/a/b/c/d.ts' }, '…/c/d.ts')).toBe(false);
	});
});

describe('toolOutcome', () => {
	it('labels approval decisions and answered questions', async () => {
		const { toolOutcome } = await import('$lib/tool-meta.js');
		expect(toolOutcome('approval', { decision: 'accept' })).toEqual({
			label: 'Approved',
			negative: false
		});
		expect(toolOutcome('approval', { decision: 'decline' })?.negative).toBe(true);
		expect(toolOutcome('approval', { decision: null })).toBeNull();
		expect(toolOutcome('question', { status: 'answered' })?.label).toBe('Answered');
		expect(toolOutcome('run_command', { decision: 'accept' })).toBeNull();
	});
});

describe('subagentActivity', () => {
	it('shows progress while running and the result once done', async () => {
		const { subagentActivity } = await import('$lib/tool-meta.js');
		const input = {
			description: 'Audit',
			prompt: 'Review the routes\nin detail',
			progress: 'Reading hooks.server.ts'
		};
		expect(subagentActivity(input, undefined, 'running')).toBe('Reading hooks.server.ts');
		expect(subagentActivity({ prompt: 'Review the routes' }, undefined, 'running')).toBe(
			'Review the routes'
		);
		expect(subagentActivity(input, '## Findings\n- **High**: missing auth', 'done')).toBe(
			'High: missing auth'
		);
		expect(
			subagentActivity(
				input,
				'This agent\'s report was delivered to you as a message from "a1".',
				'done'
			)
		).toBe('Reported back to the main agent');
		expect(subagentActivity(input, 'rate limited', 'failed')).toBe('rate limited');
	});
});

describe('reasoningTiming', () => {
	it('reads the recorded start and end of a coding-agent thought', async () => {
		const { reasoningTiming } = await import('./timeline.js');
		const part = {
			type: 'reasoning',
			providerMetadata: { t3: { startedAt: 1000, completedAt: 13000 } }
		} as PartLike;
		expect(reasoningTiming(part)).toEqual({ startedAt: 1000, completedAt: 13000 });
		expect(reasoningTiming({ type: 'reasoning' })).toEqual({ startedAt: null, completedAt: null });
	});
});

describe('hasVisibleContent', () => {
	it('ignores bookkeeping parts and empty text', () => {
		expect(hasVisibleContent([])).toBe(false);
		expect(hasVisibleContent([{ type: 'step-start' }])).toBe(false);
		expect(hasVisibleContent([{ type: 'step-start' }, text(''), text('  \n')])).toBe(false);
		expect(hasVisibleContent([{ type: 'reasoning', text: '' } as PartLike])).toBe(false);
	});

	it('counts text, reasoning, tool calls and files', () => {
		expect(hasVisibleContent([{ type: 'step-start' }, text('hi')])).toBe(true);
		expect(hasVisibleContent([{ type: 'reasoning', text: 'hmm' } as PartLike])).toBe(true);
		expect(hasVisibleContent([tool('fs_read')])).toBe(true);
		expect(hasVisibleContent([{ type: 'file' }])).toBe(true);
	});
});
