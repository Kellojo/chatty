import { describe, expect, it } from 'vitest';
import {
	describeStreamClose,
	parsePreviewTabs,
	parseStreamMessage,
	sanitizePreviewInput
} from './preview.js';

describe('parsePreviewTabs', () => {
	it('maps T3 preview sessions to tabs', () => {
		const tabs = parsePreviewTabs({
			serverEpoch: 'e1',
			revision: 3,
			sessions: [
				{
					threadId: 't1',
					tabId: 'tab-1',
					navStatus: { _tag: 'Success', url: 'http://localhost:5173/', title: 'App' },
					canGoBack: true,
					canGoForward: false,
					updatedAt: '2026-11-08T10:00:00Z'
				},
				{
					threadId: 't1',
					tabId: 'tab-2',
					navStatus: {
						_tag: 'LoadFailed',
						url: 'http://localhost:9999/',
						title: '',
						code: -102,
						description: 'Connection refused'
					},
					canGoBack: false,
					canGoForward: false
				},
				{ threadId: 't1', tabId: 'tab-3', navStatus: { _tag: 'Idle' } }
			]
		});
		expect(tabs).toEqual([
			{
				tabId: 'tab-1',
				url: 'http://localhost:5173/',
				title: 'App',
				status: 'ready',
				error: null,
				canGoBack: true,
				canGoForward: false
			},
			{
				tabId: 'tab-2',
				url: 'http://localhost:9999/',
				title: null,
				status: 'failed',
				error: 'Connection refused',
				canGoBack: false,
				canGoForward: false
			},
			{
				tabId: 'tab-3',
				url: null,
				title: null,
				status: 'idle',
				error: null,
				canGoBack: false,
				canGoForward: false
			}
		]);
	});

	it('skips malformed entries and tolerates junk', () => {
		expect(parsePreviewTabs(null)).toEqual([]);
		expect(parsePreviewTabs({ sessions: 'nope' })).toEqual([]);
		expect(parsePreviewTabs({ sessions: [null, { tabId: '' }, 5] })).toEqual([]);
	});
});

describe('sanitizePreviewInput', () => {
	it('keeps known fields of supported input', () => {
		expect(
			sanitizePreviewInput({
				type: 'mouse',
				action: 'down',
				x: 10,
				y: 20,
				button: 'left',
				buttons: 1,
				clickCount: 2,
				modifiers: 8,
				extra: 'dropped'
			})
		).toEqual({
			type: 'mouse',
			action: 'down',
			x: 10,
			y: 20,
			button: 'left',
			buttons: 1,
			clickCount: 2,
			modifiers: 8
		});
		expect(
			sanitizePreviewInput({ type: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a' })
		).toEqual({ type: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 });
		expect(sanitizePreviewInput({ type: 'history', delta: -5 })).toEqual({
			type: 'history',
			delta: -1
		});
		expect(sanitizePreviewInput({ type: 'takeControl', id: 'x' })).toEqual({
			type: 'takeControl'
		});
	});

	it('only navigates to web URLs', () => {
		expect(sanitizePreviewInput({ type: 'navigate', url: 'https://example.com' })).toEqual({
			type: 'navigate',
			url: 'https://example.com'
		});
		expect(sanitizePreviewInput({ type: 'navigate', url: 'file:///etc/passwd' })).toBeNull();
		expect(sanitizePreviewInput({ type: 'navigate', url: 'javascript:alert(1)' })).toBeNull();
	});

	it('rejects unknown or malformed input', () => {
		expect(sanitizePreviewInput({ type: 'ack' })).toBeNull();
		expect(sanitizePreviewInput({ type: 'dialog', accept: true })).toBeNull();
		expect(sanitizePreviewInput({ type: 'mouse', action: 'down', x: 'a', y: 1 })).toBeNull();
		expect(sanitizePreviewInput({ type: 'mouse', action: 'drag', x: 1, y: 1 })).toBeNull();
		expect(
			sanitizePreviewInput({ type: 'mouse', action: 'up', x: 1, y: 1, modifiers: 99 })
		).toMatchObject({ modifiers: 0 });
		expect(sanitizePreviewInput([])).toBeNull();
		expect(sanitizePreviewInput('mouse')).toBeNull();
	});
});

describe('parseStreamMessage', () => {
	it('decodes viewport, control and popup state', () => {
		expect(parseStreamMessage('{"type":"viewport","width":1280,"height":800}')).toEqual({
			type: 'viewport',
			width: 1280,
			height: 800
		});
		expect(
			parseStreamMessage(
				'{"type":"control","canOperate":true,"controller":"agent","generation":2,"dialog":null}'
			)
		).toEqual({ type: 'control', canOperate: true, controller: 'agent' });
		expect(parseStreamMessage('{"type":"popup","tabId":"tab-9"}')).toEqual({
			type: 'popup',
			tabId: 'tab-9'
		});
	});

	it('drops other kinds and junk', () => {
		expect(parseStreamMessage('{"type":"clipboard","text":"x"}')).toBeNull();
		expect(parseStreamMessage('{"type":"control","controller":"root"}')).toBeNull();
		expect(parseStreamMessage('{"type":"viewport","width":0,"height":10}')).toBeNull();
		expect(parseStreamMessage('not json')).toBeNull();
	});
});

describe('describeStreamClose', () => {
	it('explains why the stream ended', () => {
		expect(describeStreamClose(4404, 'tab closed').reason).toBe('gone');
		expect(describeStreamClose(1012, 'reconnect').reason).toBe('restart');
		expect(describeStreamClose(1006, '').reason).toBe('error');
		const setup = describeStreamClose(
			4503,
			JSON.stringify({ need: 'sandbox', command: 't3 setup-browser' })
		);
		expect(setup.reason).toBe('unavailable');
		expect(setup.message).toContain('`t3 setup-browser`');
		expect(describeStreamClose(4503, 'garbled').message).not.toContain('`');
	});
});
