<script lang="ts">
	import { setMode } from 'mode-watcher';
	import CheckIcon from '@lucide/svelte/icons/check';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { MAX_GLOBAL_INSTRUCTIONS_LENGTH, type Theme } from '$lib/user-settings.js';
	import StepFooter from './StepFooter.svelte';
	import ThemePicker from '../ThemePicker.svelte';
	import type { OnboardingFlowState } from './onboarding-state.svelte.js';

	let {
		flow,
		onback,
		onnext
	}: { flow: OnboardingFlowState; onback: () => void; onnext: () => void } = $props();

	const QUICK_ADDS = [
		'Be concise; skip the preamble.',
		'Explain things like I’m new to the topic.',
		'Show code first, then explain.',
		'Use metric units and 24-hour time.',
		'Ask a clarifying question when my request is ambiguous.'
	];

	let saving = $state(false);
	let error = $state('');

	async function putSettings(body: Record<string, unknown>) {
		const res = await fetch('/api/user/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error(`Request failed (${res.status})`);
	}

	async function chooseTheme(theme: Theme) {
		if (theme === flow.theme) return;
		const previous = flow.theme;
		flow.theme = theme;
		setMode(theme);
		try {
			await putSettings({ theme });
		} catch {
			flow.theme = previous;
			setMode(previous);
			error = 'Couldn’t save the theme. Try again.';
		}
	}

	function addLine(line: string) {
		const current = flow.instructions.trimEnd();
		if (current.includes(line)) return;
		flow.instructions = current ? `${current}\n${line}` : line;
	}

	async function next() {
		const instructions = flow.instructions.trim();
		if (instructions === flow.savedInstructions.trim()) return onnext();
		saving = true;
		error = '';
		try {
			await putSettings({ globalInstructions: instructions });
			flow.savedInstructions = instructions;
			onnext();
		} catch {
			error = 'Couldn’t save your instructions. Try again.';
		} finally {
			saving = false;
		}
	}
</script>

<header class="flex flex-col gap-2">
	<p class="text-sm font-medium text-muted-foreground">Personalize</p>
	<h1
		data-step-heading
		tabindex="-1"
		class="text-2xl font-semibold tracking-tight text-balance outline-none sm:text-3xl"
	>
		Make it yours
	</h1>
	<p class="max-w-xl text-pretty text-muted-foreground">
		Both are optional and can be changed anytime in Settings.
	</p>
</header>

<section class="mt-8" aria-labelledby="look-title">
	<h2 id="look-title" class="text-sm font-medium">Appearance</h2>
	<ThemePicker value={flow.theme} onchange={chooseTheme} labelledby="look-title" class="mt-3" />
</section>

<section class="mt-8" aria-labelledby="about-title">
	<div class="flex items-baseline justify-between gap-2">
		<h2 id="about-title" class="text-sm font-medium">How should Chatty respond?</h2>
		<span class="text-xs text-muted-foreground tabular-nums" aria-hidden="true">
			{flow.instructions.length}/{MAX_GLOBAL_INSTRUCTIONS_LENGTH}
		</span>
	</div>
	<p id="about-hint" class="mt-1 text-sm text-muted-foreground">
		Added to every chat. Tell it about you, your work, or the style you like.
	</p>
	<Textarea
		bind:value={flow.instructions}
		maxlength={MAX_GLOBAL_INSTRUCTIONS_LENGTH}
		rows={3}
		placeholder="I’m a product designer. Keep answers short and use bullet points."
		aria-labelledby="about-title"
		aria-describedby="about-hint"
		class="mt-3 min-h-24 resize-y placeholder:text-muted-foreground/60"
	/>
	<ul class="mt-3 flex flex-wrap gap-2" aria-label="Quick add">
		{#each QUICK_ADDS as line (line)}
			{@const added = flow.instructions.includes(line)}
			<li>
				<button
					type="button"
					disabled={added}
					onclick={() => addLine(line)}
					class="inline-flex items-center gap-1 rounded-full border border-border/80 bg-card/70 px-3 py-1 text-left text-xs text-muted-foreground transition-colors outline-none hover:border-foreground/30 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 disabled:border-transparent disabled:bg-muted disabled:text-foreground/60"
				>
					{#if added}<CheckIcon class="size-3" aria-hidden="true" />{:else}<PlusIcon
							class="size-3"
							aria-hidden="true"
						/>{/if}
					{line}
				</button>
			</li>
		{/each}
	</ul>
</section>

{#if error}
	<p class="mt-4 text-sm text-destructive" role="alert">{error}</p>
{/if}

<StepFooter {onback} onnext={next} busy={saving} />
