<script lang="ts">
	// Turns Web Push on or off for this device and sends a test through the
	// server, so you can check it reaches a closed app or a locked phone.
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import SendIcon from '@lucide/svelte/icons/send';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import SettingsSection from './SettingsSection.svelte';
	import SettingsRow from './SettingsRow.svelte';
	import {
		currentPushSubscription,
		disablePush,
		enablePush,
		pushSupport,
		sendTestPush,
		syncPushSubscription,
		type PushSupport
	} from '$lib/notifications/push.js';

	let support = $state<PushSupport>('supported');
	let enabled = $state(false);
	let blocked = $state(false);
	let busy = $state(false);
	let testing = $state(false);
	let ready = $state(false);

	async function refresh() {
		support = pushSupport();
		blocked = typeof Notification !== 'undefined' && Notification.permission === 'denied';
		enabled =
			support === 'supported' &&
			!blocked &&
			(await currentPushSubscription()) !== null &&
			Notification.permission === 'granted';
		ready = true;
	}

	onMount(() => {
		void refresh();
		// Permission can change from the browser's site settings while we're open.
		const onFocus = () => void refresh();
		window.addEventListener('focus', onFocus);
		return () => window.removeEventListener('focus', onFocus);
	});

	async function setEnabled(next: boolean) {
		if (busy) return;
		busy = true;
		try {
			if (next) {
				await enablePush();
				enabled = true;
				toast.success('Push is on for this device.');
			} else {
				await disablePush();
				enabled = false;
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not change push');
			await refresh();
		} finally {
			busy = false;
		}
	}

	async function test() {
		if (testing) return;
		testing = true;
		try {
			// Make sure the server still has this device before blaming the push service.
			await syncPushSubscription();
			await sendTestPush();
			toast.success('Test sent. It can take a few seconds to arrive.');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not send a test');
		} finally {
			testing = false;
		}
	}

	const hint = $derived.by(() => {
		if (support === 'needs-install') {
			return 'On iPhone and iPad, push works only in the installed app: tap Share, then Add to Home Screen, and open Chatty from there.';
		}
		if (support === 'insecure') {
			return 'Push needs HTTPS. Open Chatty through an https:// address (for example Tailscale HTTPS).';
		}
		if (support === 'unsupported') return "This browser can't receive push notifications.";
		if (blocked) {
			return 'Notifications are blocked for this site. Allow them in your browser or system settings, then come back.';
		}
		return "Notify this device even when Chatty is closed or the phone is locked. Stops if you're signed out here, or don't open Chatty on this device for a week.";
	});
	const unavailable = $derived(support !== 'supported' || blocked);
</script>

<SettingsSection
	title="Push notifications"
	description="Sent by the server, so they arrive while Chatty is closed. Held back while you're using Chatty on any device."
>
	{#snippet action()}
		{#if enabled}
			<Button variant="outline" size="sm" onclick={test} disabled={testing}>
				<SendIcon class="size-4" />
				{testing ? 'Sending…' : 'Send test push'}
			</Button>
		{/if}
	{/snippet}
	<SettingsRow label="Push to this device" for="pref-push">
		{#snippet description()}
			<span class={unavailable ? 'text-amber-700 dark:text-amber-400' : undefined}>{hint}</span>
		{/snippet}
		<Switch
			id="pref-push"
			checked={enabled}
			disabled={!ready || busy || unavailable}
			onCheckedChange={setEnabled}
		/>
	</SettingsRow>
</SettingsSection>
