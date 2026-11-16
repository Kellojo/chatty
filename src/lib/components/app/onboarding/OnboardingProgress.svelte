<script lang="ts">
	import { STEP_LABELS, type OnboardingStep } from '$lib/onboarding.js';

	let { steps, current }: { steps: OnboardingStep[]; current: number } = $props();
</script>

<!-- Decorative: the live region in the page announces "Step n of N". -->
<div class="flex items-center gap-3" aria-hidden="true">
	<ol class="flex items-center gap-1.5 lg:gap-4">
		{#each steps as step, i (step)}
			<li class="flex flex-col items-center gap-1.5">
				<span
					class={[
						'block h-2 rounded-full transition-all duration-500 ease-out motion-reduce:transition-none lg:h-1.5',
						i === current ? 'w-8 bg-foreground sm:w-12 lg:w-full' : 'w-2 sm:w-6 lg:w-full',
						i < current && 'bg-foreground/45',
						i > current && 'bg-muted-foreground/35'
					]}
				></span>
				<span
					class={[
						'hidden text-xs whitespace-nowrap transition-colors lg:block',
						i === current ? 'font-medium text-foreground' : 'text-muted-foreground'
					]}>{STEP_LABELS[step]}</span
				>
			</li>
		{/each}
	</ol>
	<span class="text-xs font-medium text-foreground/70 tabular-nums lg:hidden"
		>{current + 1}/{steps.length}</span
	>
</div>
