<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import {
		defaultCustomSnooze,
		formatSnoozeTime,
		fromDateTimeInput,
		isSnoozed,
		snoozeTimeError,
		toDateTimeInput
	} from '$lib/snooze.js';
	import { snoozeConversation, type SnoozeChanged } from '$lib/snooze-actions.js';
	import type { Conversation } from '$lib/types.js';

	/** Snooze until a date and time of your choosing. Open while `conversation` is set. */
	let {
		conversation,
		onclose,
		onchanged
	}: {
		conversation: Conversation | null;
		onclose: () => void;
		onchanged: SnoozeChanged;
	} = $props();

	let value = $state('');
	let saving = $state(false);
	let opened = $state<string | null>(null);

	// Starts from the current snooze, else tomorrow morning, each time it opens.
	$effect.pre(() => {
		const c = conversation;
		if (!c) {
			opened = null;
			return;
		}
		if (opened === c.id) return;
		opened = c.id;
		value = toDateTimeInput(isSnoozed(c) ? c.snoozedUntil! : defaultCustomSnooze());
	});

	const until = $derived(fromDateTimeInput(value));
	const problem = $derived(snoozeTimeError(until));

	function close() {
		onclose();
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		// Checked again: the time may have passed while the dialog stood open.
		if (!conversation || until === null || snoozeTimeError(until) || saving) return;
		saving = true;
		try {
			if (await snoozeConversation(conversation, until, onchanged)) close();
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root open={conversation !== null} onOpenChange={(open) => !open && close()}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Snooze until…</Dialog.Title>
			<Dialog.Description>
				The chat leaves your list and comes back at this time.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={submit} class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="snooze-until">Date and time</Label>
				<Input
					id="snooze-until"
					type="datetime-local"
					bind:value
					min={toDateTimeInput(Date.now())}
					aria-describedby="snooze-until-hint"
					aria-invalid={problem !== null && value !== ''}
				/>
				<p
					id="snooze-until-hint"
					class="text-xs {problem ? 'text-destructive' : 'text-muted-foreground'}"
					aria-live="polite"
				>
					{problem ?? `Until ${formatSnoozeTime(until!)}`}
				</p>
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={close}>Cancel</Button>
				<Button type="submit" disabled={problem !== null || saving}>Snooze</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
