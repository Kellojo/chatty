import { describe, expect, it } from 'vitest';
import {
	isCodingTaskProposalPart,
	parseCodingTaskProposal,
	parseCodingTaskProposalTarget
} from './coding-task-proposal.js';

describe('coding task proposals', () => {
	it('recognises the tool call in static and dynamic tool parts', () => {
		expect(isCodingTaskProposalPart({ type: 'tool-propose_coding_task' })).toBe(true);
		expect(
			isCodingTaskProposalPart({ type: 'dynamic-tool', toolName: 'propose_coding_task' })
		).toBe(true);
		expect(isCodingTaskProposalPart({ type: 'tool-start_agent' })).toBe(false);
		expect(isCodingTaskProposalPart({ type: 'text' })).toBe(false);
	});

	it('parses the arguments, waiting for a prompt', () => {
		expect(parseCodingTaskProposal({ title: '  Fix it ', prompt: ' Do X ' })).toEqual({
			title: 'Fix it',
			prompt: 'Do X'
		});
		expect(parseCodingTaskProposal({ prompt: 'Do X', title: ' ' })).toEqual({
			title: null,
			prompt: 'Do X'
		});
		expect(parseCodingTaskProposal({ title: 'Fix it' })).toBeNull();
		expect(parseCodingTaskProposal(undefined)).toBeNull();
	});
});

describe('proposal targets', () => {
	const output = (body: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
	const target = {
		environmentId: 'env-1',
		environmentName: 'devbox',
		projectId: 'p-1',
		projectTitle: 'ai-chat'
	};

	it('reads the checked target from the tool result', () => {
		expect(parseCodingTaskProposalTarget(output({ proposed: true, target }))).toEqual(target);
	});

	it('is null without a target, or for malformed results', () => {
		expect(parseCodingTaskProposalTarget(output({ proposed: true, target: null }))).toBeNull();
		expect(parseCodingTaskProposalTarget(output({ target: { projectId: 'p-1' } }))).toBeNull();
		expect(parseCodingTaskProposalTarget({ content: [{ type: 'text', text: 'oops' }] })).toBeNull();
		expect(parseCodingTaskProposalTarget(undefined)).toBeNull();
	});
});
