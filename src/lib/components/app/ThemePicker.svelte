<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import { THEMES, type Theme } from '$lib/user-settings.js';
	import { cn } from '$lib/utils.js';
	import ThemePreview from './onboarding/ThemePreview.svelte';

	/** Light / dark / system as preview tiles, one radio group (arrow keys move and select). */
	let {
		value,
		onchange,
		labelledby,
		describedby,
		class: className
	}: {
		value: Theme;
		onchange: (theme: Theme) => void;
		labelledby?: string;
		describedby?: string;
		class?: string;
	} = $props();

	const OPTIONS: Record<Theme, { label: string; icon: typeof SunIcon }> = {
		light: { label: 'Light', icon: SunIcon },
		dark: { label: 'Dark', icon: MoonIcon },
		system: { label: 'System', icon: MonitorIcon }
	};

	let buttons: HTMLButtonElement[] = $state([]);

	function onkeydown(event: KeyboardEvent, index: number) {
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
		const target =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? THEMES.length - 1
					: step === undefined
						? undefined
						: (index + step + THEMES.length) % THEMES.length;
		if (target === undefined) return;
		event.preventDefault();
		buttons[target]?.focus();
		onchange(THEMES[target]);
	}
</script>

<div
	class={cn('grid grid-cols-3 gap-2 sm:gap-3', className)}
	role="radiogroup"
	aria-labelledby={labelledby}
	aria-describedby={describedby}
>
	{#each THEMES as theme, index (theme)}
		{@const selected = value === theme}
		{@const option = OPTIONS[theme]}
		<button
			bind:this={buttons[index]}
			type="button"
			role="radio"
			aria-checked={selected}
			tabindex={selected ? 0 : -1}
			onclick={() => onchange(theme)}
			onkeydown={(event) => onkeydown(event, index)}
			class={[
				'group flex min-w-0 flex-col gap-2 rounded-2xl border p-1.5 text-left transition-[border-color,box-shadow,background-color,scale] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-safe:active:scale-[0.98] motion-reduce:transition-none sm:p-2',
				selected
					? 'border-foreground/80 bg-card ring-1 ring-foreground/80'
					: 'border-border bg-card hover:border-foreground/30 hover:bg-accent/40'
			]}
		>
			<ThemePreview {theme} />
			<span class="flex min-w-0 items-center gap-1.5 px-1 pb-0.5 text-sm font-medium">
				<!-- Phones drop the icon so the label and check fit a third of the screen. -->
				<option.icon
					class={[
						'hidden size-3.5 shrink-0 transition-colors sm:block',
						selected ? 'text-foreground' : 'text-muted-foreground'
					]}
					aria-hidden="true"
				/>
				<span class="truncate">{option.label}</span>
				<!-- A check as well as the ring, so the choice doesn't rest on colour alone. -->
				{#if selected}
					<span
						class="ml-auto flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground text-background"
					>
						<CheckIcon class="size-3" aria-hidden="true" />
					</span>
				{/if}
			</span>
		</button>
	{/each}
</div>
