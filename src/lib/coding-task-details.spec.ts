import { describe, expect, it } from 'vitest';
import type { CodingConversation } from './coding-environments.js';
import {
	agentIsFree,
	autonomyFromRuntimeMode,
	canCreatePullRequest,
	CODING_RUNTIME_MODES,
	createPullRequestPrompt,
	hasPullRequestWork,
	pullRequestNumber,
	recoveryAction,
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
	prState: null,
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

	it('offers a pull request only for unpublished work while the agent is free', () => {
		expect(canCreatePullRequest(task())).toBe(true);
		expect(canCreatePullRequest(task({ status: 'failed' }))).toBe(true);
		expect(canCreatePullRequest(task({ status: 'running' }))).toBe(false);
		expect(canCreatePullRequest(task({ status: 'awaiting_input' }))).toBe(false);
		expect(canCreatePullRequest(task({ prUrl: 'https://github.com/o/r/pull/1' }))).toBe(false);
	});

	it('offers a retry for failed tasks and a continue for interrupted ones', () => {
		expect(recoveryAction(task())).toBeNull();
		expect(recoveryAction(task({ status: 'running' }))).toBeNull();

		const retry = recoveryAction(task({ status: 'failed', lastError: 'Rate limited' }));
		expect(retry).toMatchObject({ kind: 'retry', label: 'Retry' });
		expect(retry?.prompt).toContain('Rate limited');

		const unstarted = recoveryAction(task({ status: 'failed', threadId: null }));
		expect(unstarted).toMatchObject({ kind: 'retry', prompt: null });

		const resume = recoveryAction(task({ status: 'interrupted' }));
		expect(resume).toMatchObject({ kind: 'continue', label: 'Continue' });
		expect(resume?.prompt).toContain('continue where you left off');
		expect(recoveryAction(task({ status: 'interrupted', threadId: null }))).toBeNull();
	});

	it('caps the error quoted in a retry', () => {
		const prompt = recoveryAction(task({ status: 'failed', lastError: 'x'.repeat(5000) }))!.prompt!;
		expect(prompt.length).toBeLessThan(1000);
	});

	it('maps autonomy to T3 runtime modes and back', () => {
		expect(CODING_RUNTIME_MODES.supervised).toBe('approval-required');
		expect(autonomyFromRuntimeMode('auto-accept-edits')).toBe('auto-edits');
		expect(autonomyFromRuntimeMode('full-access')).toBe('full-access');
		expect(autonomyFromRuntimeMode('custom')).toBeNull();
	});
});
