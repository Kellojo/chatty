import { describe, expect, it } from 'vitest';
import {
	buildOnboardingSteps,
	parseOnboardingState,
	pickDefaultChatModel,
	resumeStep
} from './onboarding.js';

describe('buildOnboardingSteps', () => {
	it('asks an admin on an empty instance to connect a model', () => {
		expect(buildOnboardingSteps({ isAdmin: true, hasUsableChatModel: false })).toEqual([
			'welcome',
			'model',
			'personalize',
			'concepts',
			'ready'
		]);
	});

	it('skips the model step once a model is usable', () => {
		expect(buildOnboardingSteps({ isAdmin: true, hasUsableChatModel: true })).not.toContain(
			'model'
		);
	});

	it('never shows the model step to a non-admin', () => {
		expect(buildOnboardingSteps({ isAdmin: false, hasUsableChatModel: false })).toEqual([
			'welcome',
			'personalize',
			'concepts',
			'ready'
		]);
	});
});

describe('resumeStep', () => {
	const steps = buildOnboardingSteps({ isAdmin: true, hasUsableChatModel: true });

	it('starts at the beginning with nothing saved', () => {
		expect(resumeStep(steps, null)).toBe('welcome');
	});

	it('resumes at the saved step', () => {
		expect(resumeStep(steps, 'concepts')).toBe('concepts');
	});

	it('moves past a saved step that is no longer in the flow', () => {
		// The model was connected in another tab, so `model` dropped out.
		expect(resumeStep(steps, 'model')).toBe('personalize');
	});
});

describe('parseOnboardingState', () => {
	it('treats a missing or malformed value as no onboarding', () => {
		expect(parseOnboardingState(undefined)).toEqual({ status: 'none', step: null });
		expect(parseOnboardingState({ status: 'bogus' })).toEqual({ status: 'none', step: null });
	});

	it('drops an unknown step but keeps the status', () => {
		expect(parseOnboardingState({ status: 'pending', step: 'nope' })).toEqual({
			status: 'pending',
			step: null
		});
	});
});

describe('pickDefaultChatModel', () => {
	const m = (modelId: string, ...capabilities: string[]) => ({ modelId, capabilities });

	it('prefers a model with tools and vision', () => {
		const pick = pickDefaultChatModel([
			m('a', 'chat'),
			m('b', 'chat', 'tool_use'),
			m('c', 'chat', 'tool_use', 'vision')
		]);
		expect(pick?.modelId).toBe('c');
	});

	it('falls back to tools, then any chat model, in the given order', () => {
		expect(pickDefaultChatModel([m('a', 'chat'), m('b', 'chat', 'tool_use')])?.modelId).toBe('b');
		expect(pickDefaultChatModel([m('a', 'chat'), m('b', 'chat')])?.modelId).toBe('a');
	});

	it('passes over embedding and speech models tagged as chat', () => {
		const pick = pickDefaultChatModel([
			m('text-embedding-3-large', 'chat'),
			m('whisper-1', 'chat'),
			m('gpt-4.1', 'chat')
		]);
		expect(pick?.modelId).toBe('gpt-4.1');
	});

	it('returns undefined without chat models', () => {
		expect(pickDefaultChatModel([m('x', 'image')])).toBeUndefined();
	});
});
