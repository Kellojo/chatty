import type { CodingConversation } from './coding-environments.js';

/** "#42" for GitHub/GitLab-style pull request URLs, null otherwise. */
export function pullRequestNumber(url: string): string | null {
	const match = /\/(?:pull|pulls|merge_requests)\/(\d+)/.exec(url);
	return match ? `#${match[1]}` : null;
}

/** Whether the task has work worth opening a pull request for. */
export function hasPullRequestWork(coding: CodingConversation): boolean {
	if (coding.prUrl) return false;
	const changed = (coding.diff?.insertions ?? 0) + (coding.diff?.deletions ?? 0) > 0;
	const ownBranch = coding.branch !== null && coding.branch !== coding.baseBranch;
	return changed || (coding.workspaceMode === 'worktree' && ownBranch);
}

/** The agent can take a new instruction now (not mid-run or waiting on an approval). */
export function agentIsFree(coding: CodingConversation): boolean {
	return coding.status === 'idle' || coding.status === 'interrupted' || coding.status === 'failed';
}

/** Instruction sent to the coding agent when the user clicks "Create pull request". */
export function createPullRequestPrompt(coding: CodingConversation): string {
	const target = coding.baseBranch ? `\`${coding.baseBranch}\`` : 'the default branch';
	return [
		'Open a pull request for the work in this task:',
		'',
		'1. If you are on the default branch, create a new branch with a descriptive name first.',
		'2. Commit any uncommitted changes with a clear message.',
		'3. Push the branch.',
		`4. Create a pull request against ${target} with a concise title and a description that summarises the changes and how they were tested.`,
		'',
		'Reply with the pull request URL.'
	].join('\n');
}

const RUNTIME_LABELS: Record<string, string> = {
	supervised: 'Ask first',
	'approval-required': 'Ask first',
	'auto-edits': 'Auto-accept edits',
	'auto-accept-edits': 'Auto-accept edits',
	auto: 'Auto',
	'full-access': 'Full access'
};

/** How much the agent may do on its own, as shown when starting a task. */
export function runtimeModeLabel(mode: string): string {
	return RUNTIME_LABELS[mode] ?? mode;
}
