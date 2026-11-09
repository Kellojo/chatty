<script lang="ts">
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';

	let { message, id }: { message: string; id?: string } = $props();
</script>

<div
	{id}
	role="alert"
	class="flex items-start gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
>
	<CircleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
	<span>{message}</span>
</div>
