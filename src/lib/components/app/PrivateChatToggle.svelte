<script lang="ts">
	import { resolve } from '$app/paths';
	import LockIcon from '@lucide/svelte/icons/lock';
	import LockOpenIcon from '@lucide/svelte/icons/lock-open';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { cn } from '$lib/utils.js';
	import type { PrivateDataStatus } from '$lib/types.js';

	/**
	 * The new-chat composer's lock: starts the chat private, so only trusted
	 * models see it. Hidden while the
	 * private-data feature is off; disabled (with a pointer to Settings →
	 * Providers) until a provider is trusted with private data.
	 */
	let {
		checked = $bindable(false),
		status,
		admin = false,
		disabled = false,
		onchange
	}: {
		checked?: boolean;
		status: PrivateDataStatus;
		/** Admins can trust a provider themselves: the disabled hint links there. */
		admin?: boolean;
		disabled?: boolean;
		onchange?: (checked: boolean) => void;
	} = $props();

	// Taps don't hover: a tap on the disabled lock shows its hint too.
	let hintOpen = $state(false);

	function toggle() {
		checked = !checked;
		onchange?.(checked);
	}
</script>

{#if status.enabled}
	{#if !status.available}
		<Tooltip.Provider delayDuration={200}>
			<Tooltip.Root bind:open={hintOpen}>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon"
							aria-label="Private chat"
							aria-disabled="true"
							aria-describedby="private-chat-unavailable"
							class="relative cursor-help text-muted-foreground/80 hover:bg-transparent hover:text-muted-foreground"
							onclick={() => (hintOpen = true)}
						>
							<LockOpenIcon class="size-4" />
							<!-- Says at a glance that it can't be used yet, without a hover. -->
							<span
								class="absolute right-1.5 bottom-1.5 size-1.5 rounded-full bg-amber-500 ring-2 ring-background"
								aria-hidden="true"
							></span>
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content class="max-w-64 flex-col items-start gap-1 px-3 py-2 text-left">
					<span id="private-chat-unavailable">
						Private chats need a provider trusted with private data.
					</span>
					{#if admin}
						<a
							href={resolve('/settings/providers')}
							class="rounded-sm font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
							>Set one up in Settings → Providers</a
						>
					{:else}
						<span class="opacity-80">Ask an admin to trust one in Settings → Providers.</span>
					{/if}
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	{:else}
		<Button
			variant="ghost"
			size={checked ? 'sm' : 'icon'}
			aria-label="Private chat"
			aria-pressed={checked}
			{disabled}
			title={checked
				? 'Private chat: only models trusted with private data see it. Click to turn off.'
				: 'Make this chat private'}
			class={cn(
				checked
					? 'gap-1.5 bg-emerald-500/10 px-2.5 text-emerald-800 ring-1 ring-emerald-600/30 hover:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/30'
					: 'text-muted-foreground hover:text-foreground'
			)}
			onclick={toggle}
		>
			{#if checked}
				<LockIcon class="size-4" />
				<span class="text-xs font-medium max-sm:sr-only">Private</span>
			{:else}
				<LockOpenIcon class="size-4" />
			{/if}
		</Button>
	{/if}
{/if}
