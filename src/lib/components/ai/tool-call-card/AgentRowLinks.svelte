<script lang="ts">
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';

	/**
	 * Where an opened agent row leads: its live view while it works ("Watch
	 * live"), its transcript or run once it's done. Shown inside the row's
	 * details, so the collapsed row needs no buttons of its own.
	 */
	let { links }: { links: { href: string; label: string; live?: boolean; primary?: boolean }[] } =
		$props();
</script>

{#if links.length > 0}
	<div class="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1">
		{#each links as link (link.href + link.label)}
			<!-- eslint-disable svelte/no-navigation-without-resolve -- callers pass resolve()d hrefs -->
			<a
				href={link.href}
				class="inline-flex items-center gap-1 rounded py-0.5 text-[13px] text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:py-2 {link.primary
					? 'font-semibold'
					: 'font-medium'}"
			>
				{#if link.live}
					<!-- A live dot, like a recording light: it is happening now. -->
					<span
						class="size-1.5 animate-pulse rounded-full bg-info motion-reduce:animate-none"
						aria-hidden="true"
					></span>
				{/if}
				{link.label}
				<ArrowUpRightIcon class="size-3" aria-hidden="true" />
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/each}
	</div>
{/if}
