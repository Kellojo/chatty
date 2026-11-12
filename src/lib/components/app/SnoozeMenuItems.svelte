<script lang="ts">
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { isSnoozed, snoozeOptions } from '$lib/snooze.js';
	import { snoozeConversation, wakeConversation, type SnoozeChanged } from '$lib/snooze-actions.js';
	import type { Conversation } from '$lib/types.js';
	import AlarmClockIcon from '@lucide/svelte/icons/alarm-clock';
	import AlarmClockOffIcon from '@lucide/svelte/icons/alarm-clock-off';
	import CalendarClockIcon from '@lucide/svelte/icons/calendar-clock';

	/**
	 * A conversation menu's snooze entries: a "Snooze" submenu with the presets
	 * and a custom time, plus "Wake now" while it is snoozed. Settled
	 * conversations can't be snoozed.
	 */
	let {
		conversation,
		onchanged,
		oncustom
	}: {
		conversation: Conversation;
		onchanged: SnoozeChanged;
		/**
		 * Opens the custom-time dialog. It lives outside the menu, whose content
		 * unmounts when it closes.
		 */
		oncustom: () => void;
	} = $props();

	const snoozed = $derived(isSnoozed(conversation));
</script>

{#if conversation.settledAt === null}
	{#if snoozed}
		<DropdownMenu.Item onSelect={() => void wakeConversation(conversation, onchanged)}>
			<AlarmClockOffIcon class="size-4" />
			Wake now
		</DropdownMenu.Item>
	{/if}
	<DropdownMenu.Sub>
		<DropdownMenu.SubTrigger>
			<AlarmClockIcon class="size-4" />
			{snoozed ? 'Snooze until…' : 'Snooze'}
		</DropdownMenu.SubTrigger>
		<DropdownMenu.SubContent class="w-56">
			{#each snoozeOptions() as option (option.label)}
				<DropdownMenu.Item
					onSelect={() => void snoozeConversation(conversation, option.until, onchanged)}
				>
					{option.label}
					<span class="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">{option.when}</span>
				</DropdownMenu.Item>
			{/each}
			<DropdownMenu.Separator />
			<DropdownMenu.Item onSelect={oncustom}>
				<CalendarClockIcon class="size-4" />
				Pick date and time…
			</DropdownMenu.Item>
		</DropdownMenu.SubContent>
	</DropdownMenu.Sub>
{/if}
