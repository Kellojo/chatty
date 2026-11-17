<script lang="ts">
	import LockIcon from '@lucide/svelte/icons/lock';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { cn } from '$lib/utils.js';

	/**
	 * The chat header's quiet lock chip, icon-only so the title keeps its room. Hover
	 * (or tap) explains what a private chat means, so the rule is never more than a
	 * glance away.
	 */
	let { class: className }: { class?: string } = $props();

	// Taps don't hover: a tap toggles the explanation too.
	let open = $state(false);
</script>

<Tooltip.Provider delayDuration={200}>
	<Tooltip.Root bind:open>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					type="button"
					aria-label="Private chat"
					class={cn(
						// The invisible ::after widens the tap target on touch screens.
						"relative inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-emerald-600/30 bg-emerald-500/10 text-emerald-800 transition-colors after:absolute after:-inset-3 after:content-[''] hover:bg-emerald-500/15 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none sm:after:hidden dark:border-emerald-400/30 dark:text-emerald-300",
						className
					)}
					onclick={() => (open = !open)}
				>
					<LockIcon class="size-3" aria-hidden="true" />
				</button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content class="max-w-64 text-left">
			Private chat: only models trusted with private data can continue it.
		</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>
