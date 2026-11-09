import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import AgentWidget from './agent-widget.svelte';

const agent = {
	id: 'a1',
	name: 'morning-briefing',
	description: 'Summarises the morning.',
	modelName: 'Claude Sonnet 4.5',
	modelId: 'claude-sonnet-4-5',
	skillNames: ['briefing'],
	toolAllowlist: [
		'search_chats',
		'read_chat',
		'get_weather',
		'search_memory',
		'fetch_url',
		'web_search',
		'x__list_issues'
	],
	triggerType: 'schedule',
	triggerConfig: { cron: '0 9 * * 1-5' },
	codingTarget: null,
	enabled: true,
	nextRunAt: null
};
const code = JSON.stringify(agent);

afterEach(() => vi.unstubAllGlobals());

describe('AgentWidget', () => {
	it('shows a loading state while the fence is incomplete', async () => {
		const screen = render(AgentWidget, { code: '{"id":', isIncomplete: true });
		await expect.element(screen.getByText('Setting up agent…')).toBeInTheDocument();
	});

	it('shows an error for invalid JSON or a payload without id/name', async () => {
		const bad = render(AgentWidget, { code: '{"name": 3', isIncomplete: false });
		await expect.element(bad.getByText('Could not show this agent')).toBeInTheDocument();
		const noId = render(AgentWidget, { code: '{"name":"x"}', isIncomplete: false });
		await expect.element(noId.getByText('Could not show this agent').first()).toBeInTheDocument();
	});

	it('renders name, schedule in words, model, tool chips and an Open link', async () => {
		const screen = render(AgentWidget, { code, isIncomplete: false });
		await expect
			.element(screen.getByRole('heading', { name: 'Morning Briefing' }))
			.toBeInTheDocument();
		await expect.element(screen.getByText(/^Every weekday at 9:00/)).toBeInTheDocument();
		await expect.element(screen.getByText('Claude Sonnet 4.5')).toBeInTheDocument();
		await expect.element(screen.getByText('Search chats')).toBeInTheDocument();
		await expect.element(screen.getByText('1 skill')).toBeInTheDocument();
		// 7 tools, 5 chips on wide cards → "+2" (plus the narrow-card "+4" variant).
		await expect.element(screen.getByText('+2')).toBeInTheDocument();
		await expect
			.element(screen.getByRole('link', { name: 'Open Morning Briefing' }))
			.toHaveAttribute('href', expect.stringMatching(/\/agents\/a1$/));
	});

	it('also accepts the payload wrapped as { agent }', async () => {
		const screen = render(AgentWidget, {
			code: JSON.stringify({
				agent: { ...agent, modelName: null, modelId: null, toolAllowlist: null }
			}),
			isIncomplete: false
		});
		await expect.element(screen.getByText('Chat default')).toBeInTheDocument();
		await expect.element(screen.getByText('All tools')).toBeInTheDocument();
	});

	it('runs the agent via the run endpoint and links to the run', async () => {
		const fetchMock = vi.fn(() =>
			Promise.resolve(new Response(JSON.stringify({ run: { id: 'r9' } }), { status: 202 }))
		);
		vi.stubGlobal('fetch', fetchMock);
		const screen = render(AgentWidget, { code, isIncomplete: false });
		await screen.getByRole('button', { name: /^Run now/ }).click();
		await expect
			.element(screen.getByRole('link', { name: 'View run' }))
			.toHaveAttribute('href', expect.stringMatching(/\/agents\/a1\/runs\/r9$/));
		expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/run', { method: 'POST' });
	});

	it('shows the server error when the run fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve(new Response(JSON.stringify({ message: 'No model' }), { status: 400 }))
			)
		);
		const screen = render(AgentWidget, { code, isIncomplete: false });
		await screen.getByRole('button', { name: /^Run now/ }).click();
		await expect.element(screen.getByRole('alert')).toHaveTextContent('No model.');
	});
});
