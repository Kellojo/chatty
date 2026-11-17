<script lang="ts">
	import LockIcon from '@lucide/svelte/icons/lock';
	import type { PrivacyNotice } from '$lib/private-data.js';

	/**
	 * In the reply, where it happened: a tool handed this turn private data, so
	 * the chat became private (for good). Quiet, like the tool rows around it.
	 */
	let { notice }: { notice: PrivacyNotice } = $props();
</script>

<!-- A note, not a live region: replies are re-rendered on every load. -->
<p
	class="my-1.5 flex w-full min-w-0 items-start gap-2 text-[13px] leading-snug text-muted-foreground"
	role="note"
	data-privacy-notice
>
	<!-- The same 20px icon slot as the tool rows, so the text lines up with their labels. -->
	<span class="flex size-5 shrink-0 items-center justify-center">
		<LockIcon class="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
	</span>
	<span class="min-w-0 pt-px">
		<span class="font-medium text-emerald-700 dark:text-emerald-300"
			>This chat read {notice.reason} and is now private.</span
		>
		From here on only trusted models can continue it.
	</span>
</p>
