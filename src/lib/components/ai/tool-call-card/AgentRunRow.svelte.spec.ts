import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import AgentRunRow from './AgentRunRow.svelte';

afterEach(() => {
	vi.unstubAllGlobals();
});

const run = (id: string, status: string) => ({
	id,
	agentId: 'agent-1',
	userId: 'u',
	trigger: 'manual',
	status,
	conversationId: null,
	error: null,
	startedAt: 1_000,
	endedAt: status === 'running' ? null : 61_000
});

/** A start_agent call that returned while its run kept working in the background. */
const startedPart = (runId: string) => ({
	toolCallId: `call-${runId}`,
	state: 'output-available' as const,
	input: { agentId: 'agent-1' },
	output: {
		content: [
			{
				type: 'text',
				text: JSON.stringify({ run: run(runId, 'running'), agent: { name: 'Researcher' } })
			}
		]
	}
});

function stubRunApi(status: string, reply: string) {
	const fetchMock = vi.fn(async (url: string) => {
		const id = decodeURIComponent(url.split('/').pop() ?? '');
		return Response.json({
			run: run(id, status),
			messages: [{ role: 'assistant', parts: [{ type: 'text', text: reply }] }]
		});
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

const runRequests = (fetchMock: ReturnType<typeof vi.fn>) =>
	fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/agent-runs/'));

describe('AgentRunRow', () => {
	it('loads a run that ended while the chat was closed only once', async () => {
		const fetchMock = stubRunApi('success', 'All done here');
		const props = { part: startedPart('run-ended'), name: 'start_agent', active: false };

		const first = render(AgentRunRow, props);
		await expect.element(page.getByText('All done here')).toBeInTheDocument();
		first.unmount();

		render(AgentRunRow, props);
		await expect.element(page.getByText('All done here')).toBeInTheDocument();
		expect(runRequests(fetchMock)).toHaveLength(1);
	});

	it('loads a run that is still working again on every mount', async () => {
		const fetchMock = stubRunApi('running', '');
		const props = { part: startedPart('run-live'), name: 'start_agent', active: false };

		const first = render(AgentRunRow, props);
		await expect.poll(() => runRequests(fetchMock).length).toBe(1);
		first.unmount();

		render(AgentRunRow, props);
		await expect.poll(() => runRequests(fetchMock).length).toBe(2);
	});
});
