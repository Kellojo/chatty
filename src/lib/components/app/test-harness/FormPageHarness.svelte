<script lang="ts">
	import type { Component } from 'svelte';

	// The page shell the form pages share: a scroll area with the padded, width-capped column.
	let {
		component: Form,
		props,
		height
	}: {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any form component
		component: Component<any>;
		props: Record<string, unknown>;
		height: number;
	} = $props();
</script>

<div class="flex flex-col bg-background" style="height: {height}px">
	<div class="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto">
		<div class="mx-auto w-full max-w-6xl p-4 *:max-w-4xl md:p-6">
			<div class="flex flex-col gap-6">
				<Form {...props} />
			</div>
		</div>
	</div>
</div>
