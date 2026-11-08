<script lang="ts">
	import { onMount } from 'svelte';
	import WifiOffIcon from '@lucide/svelte/icons/wifi-off';

	// Assume online until the browser says otherwise (matches the server render).
	let online = $state(true);

	onMount(() => {
		const update = () => (online = navigator.onLine);
		update();
		window.addEventListener('online', update);
		window.addEventListener('offline', update);
		return () => {
			window.removeEventListener('online', update);
			window.removeEventListener('offline', update);
		};
	});
</script>

{#if !online}
	<div
		role="status"
		class="pointer-events-none fixed top-[calc(0.5rem+env(safe-area-inset-top))] left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-md backdrop-blur"
	>
		<WifiOffIcon class="size-3.5" />
		Offline — showing saved chats
	</div>
{/if}
