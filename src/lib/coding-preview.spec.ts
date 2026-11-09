import { describe, expect, it } from 'vitest';
import {
	browserActivity,
	fitSize,
	isBrowserToolName,
	previewModifiers,
	toPagePoint
} from './coding-preview.js';

describe('previewModifiers', () => {
	it('uses CDP modifier bits', () => {
		const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
		expect(previewModifiers(none)).toBe(0);
		expect(previewModifiers({ ...none, altKey: true })).toBe(1);
		expect(previewModifiers({ ...none, ctrlKey: true, shiftKey: true })).toBe(10);
		expect(previewModifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(
			15
		);
	});
});

describe('toPagePoint', () => {
	const rect = { left: 100, top: 50, width: 640, height: 400 };
	const viewport = { width: 1280, height: 800 };

	it('scales displayed coordinates to the page', () => {
		expect(toPagePoint(100, 50, rect, viewport)).toEqual({ x: 0, y: 0 });
		expect(toPagePoint(420, 250, rect, viewport)).toEqual({ x: 640, y: 400 });
		expect(toPagePoint(740, 450, rect, viewport)).toEqual({ x: 1280, y: 800 });
	});

	it('clamps points outside the frame', () => {
		expect(toPagePoint(0, 1000, rect, viewport)).toEqual({ x: 0, y: 800 });
	});

	it('handles an image that has not been laid out yet', () => {
		expect(toPagePoint(10, 10, { left: 0, top: 0, width: 0, height: 0 }, viewport)).toEqual({
			x: 0,
			y: 0
		});
	});
});

describe('fitSize', () => {
	it('fits the content into the box, keeping its aspect ratio', () => {
		expect(fitSize({ width: 1280, height: 800 }, { width: 640, height: 640 })).toEqual({
			width: 640,
			height: 400
		});
		expect(fitSize({ width: 390, height: 844 }, { width: 1000, height: 422 })).toEqual({
			width: 195,
			height: 422
		});
	});

	it('scales small content up to the box', () => {
		expect(fitSize({ width: 400, height: 300 }, { width: 800, height: 800 })).toEqual({
			width: 800,
			height: 600
		});
	});

	it('is empty for an empty size', () => {
		expect(fitSize({ width: 0, height: 800 }, { width: 640, height: 640 })).toEqual({
			width: 0,
			height: 0
		});
	});
});

describe('isBrowserToolName', () => {
	it('matches tools that look at or drive a tab', () => {
		expect(isBrowserToolName('mcp__t3-code__preview_open')).toBe(true);
		expect(isBrowserToolName('mcp__t3-code__preview_act')).toBe(true);
		expect(isBrowserToolName('preview_snapshot')).toBe(true);
	});

	it('skips housekeeping and unrelated tools', () => {
		expect(isBrowserToolName('mcp__t3-code__t3_preview_close')).toBe(false);
		expect(isBrowserToolName('mcp__t3-code__preview_status')).toBe(false);
		expect(isBrowserToolName('mcp__t3-code__html_preview')).toBe(false);
		expect(isBrowserToolName('Bash')).toBe(false);
	});
});

describe('browserActivity', () => {
	const tool = (toolName: string, input: unknown = {}, output?: unknown) => ({
		type: 'dynamic-tool',
		toolName,
		input,
		output
	});

	it('is null when the agent has not used the browser', () => {
		expect(browserActivity([{ type: 'text' }, tool('Bash')], 'run')).toBeNull();
	});

	it('counts browser calls and names the latest tab', () => {
		const activity = browserActivity(
			[
				tool('mcp__t3-code__preview_open', {}, { tabId: 'tab_1', url: 'http://localhost' }),
				tool('Bash'),
				tool('mcp__t3-code__preview_act', { tabId: 'tab_2', action: 'click' })
			],
			'run-1'
		);
		expect(activity).toEqual({ run: 'run-1', calls: 2, tabId: 'tab_2' });
	});

	it('reads the tab from the result when the call does not name it', () => {
		const output = JSON.stringify({ available: true, tabId: 'tab_9', tabs: [{ tabId: 'tab_0' }] });
		expect(browserActivity([tool('mcp__t3-code__preview_open', {}, output)], 'r')?.tabId).toBe(
			'tab_9'
		);
	});
});
