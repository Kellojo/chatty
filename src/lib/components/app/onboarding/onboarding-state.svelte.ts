import type { OnboardingStep } from '$lib/onboarding.js';
import type { Theme } from '$lib/user-settings.js';

export interface OnboardingModel {
	id: string;
	modelId: string;
	displayName: string;
	capabilities: string[];
}

export interface OnboardingProvider {
	name: string;
	baseUrl: string | null;
	type: string;
}

/** The chat model new chats start with, as the last screen shows it. */
export interface DefaultModelSummary {
	id: string;
	modelId: string;
	displayName: string;
	provider: OnboardingProvider | null;
}

/** What the screens share while the user moves back and forth through them. */
export class OnboardingFlowState {
	step = $state<OnboardingStep>('welcome');
	/** +1 moving forward, -1 back: the direction screens slide. */
	direction = $state(1);
	theme = $state<Theme>('system');
	instructions = $state('');
	/** Instructions as last saved, to skip saving when nothing changed. */
	savedInstructions = $state('');
	defaultModel = $state<DefaultModelSummary | null>(null);
	/** Set once "Connect a model" succeeds; Back then shows the result, not the form. */
	connection = $state<{
		provider: OnboardingProvider;
		models: OnboardingModel[];
	} | null>(null);
	/** The admin chose "I'll do this later" on the model step. */
	modelSkipped = $state(false);

	constructor(init: {
		step: OnboardingStep;
		theme: Theme;
		instructions: string;
		defaultModel: DefaultModelSummary | null;
	}) {
		this.step = init.step;
		this.theme = init.theme;
		this.instructions = init.instructions;
		this.savedInstructions = init.instructions;
		this.defaultModel = init.defaultModel;
	}
}
