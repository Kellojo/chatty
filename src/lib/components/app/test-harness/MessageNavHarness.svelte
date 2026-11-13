<script lang="ts">
	// Test-only: the timeline in a scroller with the message rail beside it, as ChatView
	// lays them out (minus stick-to-bottom, which can't load in browser tests).
	import MessageTimeline from '../MessageTimeline.svelte';
	import MessageNav from '../MessageNav.svelte';
	import { messageText } from '$lib/chat-history.js';
	import type { UIMessage } from '$lib/types.js';

	let { messages, navHidden = false }: { messages: UIMessage[]; navHidden?: boolean } = $props();

	let scrollEl = $state<HTMLDivElement | null>(null);
	const items = $derived(
		messages.filter((m) => m.role === 'user').map((m) => ({ id: m.id, text: messageText(m) }))
	);
</script>

<div style="position: relative; height: 600px">
	<div bind:this={scrollEl} style="height: 100%; overflow-y: auto">
		<MessageTimeline {messages} />
	</div>
	<!-- Hidden by CSS, as ChatView does where the chat pane is narrow. -->
	<div style:display={navHidden ? 'none' : 'contents'}>
		<MessageNav {items} {scrollEl} />
	</div>
</div>
