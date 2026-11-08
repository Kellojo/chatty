import type { CodingAutonomy, CodingConversation } from './coding-environments.js';

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

/**
 * Whether "Create pull request" is offered: there is unpublished work and the
 * agent can take the instruction now. The one gate for every place that offers it.
 */
export function canCreatePullRequest(coding: CodingConversation): boolean {
	return hasPullRequestWork(coding) && agentIsFree(coding);
}

/** A follow-up offered on a task whose last run failed or was interrupted. */
export interface CodingRecoveryAction {
	kind: 'retry' | 'continue';
	label: string;
	hint: string;
	/** The instruction to send; null = send the last request again (the thread never started). */
	prompt: string | null;
}

/** Longest error excerpt quoted back to the agent in a retry. */
const MAX_ERROR_IN_PROMPT = 500;

/**
 * "Retry" for a failed task, "Continue" for an interrupted one; null while the
 * agent is busy or the last run ended normally.
 */
export function recoveryAction(coding: CodingConversation): CodingRecoveryAction | null {
	if (coding.status === 'failed') {
		if (!coding.threadId) {
			return {
				kind: 'retry',
				label: 'Retry',
				hint: 'The task never started; send the request again',
				prompt: null
			};
		}
		const error = coding.lastError?.trim().slice(0, MAX_ERROR_IN_PROMPT);
		return {
			kind: 'retry',
			label: 'Retry',
			hint: 'Ask the agent to try again from where it failed',
			prompt: [
				error ? `Your last run failed with this error:\n\n${error}` : 'Your last run failed.',
				'',
				'Check what was already done, fix the cause if you can, then try again and finish the task.'
			].join('\n')
		};
	}
	if (coding.status === 'interrupted' && coding.threadId) {
		return {
			kind: 'continue',
			label: 'Continue',
			hint: 'Ask the agent to pick up where it stopped',
			prompt:
				'Your last run was interrupted. Check the current state of the work, then continue where you left off and finish the task.'
		};
	}
	return null;
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

/** Chatty's autonomy choice as T3's runtime mode. */
export const CODING_RUNTIME_MODES: Record<CodingAutonomy, string> = {
	supervised: 'approval-required',
	'auto-edits': 'auto-accept-edits',
	auto: 'auto',
	'full-access': 'full-access'
};

/** The autonomy choice behind a T3 runtime mode, null for modes Chatty doesn't offer. */
export function autonomyFromRuntimeMode(mode: unknown): CodingAutonomy | null {
	const entry = Object.entries(CODING_RUNTIME_MODES).find(([, runtime]) => runtime === mode);
	return entry ? (entry[0] as CodingAutonomy) : null;
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
