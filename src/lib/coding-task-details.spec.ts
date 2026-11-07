import { describe, expect, it } from 'vitest';
import type { CodingConversation } from './coding-environments.js';
import {
	agentIsFree,
	createPullRequestPrompt,
	hasPullRequestWork,
	pullRequestNumber,
	runtimeModeLabel
} from './coding-task-details.js';

const task = (patch: Partial<CodingConversation> = {}): CodingConversation => ({
	conversationId: 'c1',
	environmentId: 'e1',
	projectId: 'p1',
	projectTitle: 'ai-chat',
	threadId: 't1',
	providerInstanceId: 'claudeAgent',
	model: 'claude-opus-5-5',
	runtimeMode: 'auto',
	workspaceMode: 'worktree',
	baseBranch: 'main',
	branch: 'feat/x',
	prUrl: null,
	status: 'idle',
	pendingRequest: null,
	lastError: null,
	runStartedAt: null,
	diff: { insertions: 3, deletions: 1 },
	...patch
});

describe('coding task details', () => {
	it('reads the pull request number from its URL', () => {
		expect(pullRequestNumber('https://github.com/o/r/pull/42')).toBe('#42');
		expect(pullRequestNumber('https://gitlab.com/o/r/-/merge_requests/7')).toBe('#7');
		expect(pullRequestNumber('https://example.com/review')).toBeNull();
	});

	it('offers a pull request only for unpublished work', () => {
		expect(hasPullRequestWork(task())).toBe(true);
		expect(hasPullRequestWork(task({ prUrl: 'https://github.com/o/r/pull/1' }))).toBe(false);
		expect(
			hasPullRequestWork(task({ workspaceMode: 'local', diff: { insertions: 0, deletions: 0 } }))
		).toBe(false);
		expect(hasPullRequestWork(task({ diff: null }))).toBe(true);
	});

	it('waits for the agent to be free', () => {
		expect(agentIsFree(task())).toBe(true);
		expect(agentIsFree(task({ status: 'running' }))).toBe(false);
		expect(agentIsFree(task({ status: 'awaiting_input' }))).toBe(false);
	});

	it('targets the base branch in the prompt', () => {
		expect(createPullRequestPrompt(task())).toContain('against `main`');
		expect(createPullRequestPrompt(task({ baseBranch: null }))).toContain('the default branch');
	});

	it('labels runtime modes from either naming', () => {
		expect(runtimeModeLabel('approval-required')).toBe('Ask first');
		expect(runtimeModeLabel('auto')).toBe('Auto');
		expect(runtimeModeLabel('custom')).toBe('custom');
	});
});
