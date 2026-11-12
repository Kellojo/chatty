<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import BellRingIcon from '@lucide/svelte/icons/bell-ring';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsRow from '$lib/components/app/settings/SettingsRow.svelte';
	import PushNotificationsSection from '$lib/components/app/settings/PushNotificationsSection.svelte';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { devicePrefs, type DevicePrefs } from '$lib/notifications/prefs.svelte.js';
	import {
		desktopPermission,
		requestDesktopPermission,
		showDesktopNotice,
		type DesktopPermission
	} from '$lib/notifications/desktop.js';
	import {
		SOUND_TONES,
		SOUND_TONE_LABEL,
		playTone,
		type SoundTone
	} from '$lib/notifications/sound.js';
	import type { NotificationTriggers } from '$lib/user-settings.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const prefs = $derived(devicePrefs.current);
	let permission = $state<DesktopPermission>('default');
	/** Values shown ahead of a save, by `channel:key`; dropped once saved or failed. */
	let pending = $state<Record<string, boolean>>({});
	let pushOnHere = $state(false);
	let pushReady = $state(false);
	let pushUnavailable = $state(false);
	/**
	 * Whether `data.pushDeviceCount` includes this device: what it had when the
	 * count was loaded. The push section reloads the count after each toggle.
	 */
	let countedHere = $state(false);
	$effect(() => {
		void data.pushDeviceCount;
		if (pushReady) countedHere = untrack(() => pushOnHere);
	});
	const pushOnElsewhere = $derived(data.pushDeviceCount - (countedHere ? 1 : 0) > 0);
	/** No device gets push, so the Push column has no effect for now. */
	const pushNowhere = $derived(pushReady && !pushOnHere && !pushOnElsewhere);
	/** Latest save per switch; only that one may clear its pending value. */
	const saveSeq: Record<string, number> = {};

	onMount(() => {
		devicePrefs.load();
		permission = desktopPermission();
		// Permission can change from the browser's site settings while we're open.
		const refresh = () => (permission = desktopPermission());
		window.addEventListener('focus', refresh);
		return () => window.removeEventListener('focus', refresh);
	});

	const TRIGGER_COPY: Record<keyof NotificationTriggers, { label: string; description: string }> = {
		needsYou: {
			label: 'Needs you',
			description: 'A coding task or agent is waiting for your approval or answer.'
		},
		replies: {
			label: 'Replies',
			description: "A chat reply finished while you weren't looking at it."
		},
		codingFinished: {
			label: 'Coding task finished',
			description: 'A coding task completed its run.'
		},
		failures: {
			label: 'Failures',
			description: 'A coding task or agent run failed.'
		},
		agentRuns: {
			label: 'Agent runs',
			description: 'A scheduled or triggered agent run finished successfully.'
		}
	};
	const TRIGGER_ORDER = [
		'needsYou',
		'replies',
		'codingFinished',
		'failures',
		'agentRuns'
	] as const satisfies readonly (keyof NotificationTriggers)[];

	/** Each trigger is set per channel: an open tab's alerts, or the server's pushes. */
	const CHANNELS = [
		{ id: 'tab', setting: 'notificationTriggers', label: 'Open tab', name: 'open-tab alerts' },
		{ id: 'push', setting: 'pushTriggers', label: 'Push', name: 'push notifications' }
	] as const;
	type Channel = (typeof CHANNELS)[number];

	async function setTrigger(channel: Channel, key: keyof NotificationTriggers, value: boolean) {
		const cell = `${channel.id}:${key}`;
		pending[cell] = value;
		const seq = (saveSeq[cell] = (saveSeq[cell] ?? 0) + 1);
		const saved = await fetch('/api/user/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ [channel.setting]: { [key]: value } })
		})
			.then((res) => res.ok)
			.catch(() => false);
		if (saved) {
			await invalidateAll().catch(() => undefined);
		} else {
			toast.error(`Couldn't change "${TRIGGER_COPY[key].label}" for ${channel.name}. Try again.`);
		}
		// A newer click on the same switch owns the value from here. After a save,
		// keep showing it until the refreshed settings agree (the refresh can fail).
		if (saveSeq[cell] !== seq) return;
		if (!saved || data.settings[channel.setting][key] === value) delete pending[cell];
	}

	function triggerOn(channel: Channel, key: keyof NotificationTriggers): boolean {
		return pending[`${channel.id}:${key}`] ?? data.settings[channel.setting][key];
	}

	/** Scrolls to a device switch further down and focuses it. */
	function showSwitch(id: string) {
		const el = document.getElementById(id);
		const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
		el?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
		el?.focus({ preventScroll: true });
	}

	function update(patch: Partial<DevicePrefs>) {
		devicePrefs.update(patch);
	}

	async function setDesktop(enabled: boolean) {
		if (!enabled) {
			update({ desktop: false });
			return;
		}
		permission = await requestDesktopPermission();
		if (permission === 'granted') {
			update({ desktop: true });
		} else {
			update({ desktop: false });
			if (permission === 'denied') {
				toast.error(
					'Notifications are blocked for this site. Allow them in your browser settings.'
				);
			}
		}
	}

	async function sendTest() {
		if (prefs.sound) playTone(prefs.tone, prefs.volume);
		if (!prefs.desktop || permission !== 'granted') {
			toast.info(
				prefs.sound
					? 'Device notifications are off, so only the sound played.'
					: 'Device notifications are off on this device.'
			);
			return;
		}
		try {
			await showDesktopNotice(
				{ title: 'Chatty', body: 'Notifications are working.', tag: 'test', url: '/' },
				() => undefined
			);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not show a notification');
		}
	}

	const canTest = $derived(prefs.sound || (prefs.desktop && permission === 'granted'));
	const desktopBlocked = $derived(permission === 'unsupported' || permission === 'denied');
	const desktopHint = $derived(
		permission === 'unsupported'
			? "This browser doesn't support notifications."
			: permission === 'denied'
				? 'Notifications are blocked for this site. Allow them in your browser or system settings, then come back.'
				: "While Chatty is open in a tab, show a system notification when you're in another app or tab. For when Chatty is closed, turn on push above."
	);
</script>

<svelte:head><title>Notifications · Settings · Chatty</title></svelte:head>

<SettingsHeader
	title="Notifications"
	description="How Chatty gets your attention when a reply lands or a task needs you. An open tab never alerts about the conversation it's showing."
/>

<!-- Visible overflow so the column headers can stick while the rows scroll. -->
<SettingsSection
	title="Notify me about"
	description="Applies to all your devices."
	class="overflow-visible"
>
	<div
		class="sticky top-0 z-10 -mt-3 -mb-2 flex justify-end gap-2 bg-card pt-3 pb-2 shadow-[0_1px_0] shadow-border/60"
		aria-hidden="true"
	>
		{#each CHANNELS as channel (channel.id)}
			<span
				class={[
					'relative left-1.5 w-14 text-center text-xs font-semibold',
					channel.id === 'push' && pushNowhere ? 'text-muted-foreground' : 'text-foreground/80'
				]}>{channel.label}</span
			>
		{/each}
	</div>
	{#each TRIGGER_ORDER as key, i (key)}
		<div
			role="group"
			aria-labelledby="trigger-{key}"
			aria-describedby="trigger-{key}-desc"
			class={[
				'flex items-center justify-between gap-x-4 sm:gap-x-6',
				i > 0 && 'border-t border-border/60 pt-4'
			]}
		>
			<div class="flex min-w-0 flex-col gap-1">
				<span id="trigger-{key}" class="text-sm leading-none font-medium"
					>{TRIGGER_COPY[key].label}</span
				>
				<p id="trigger-{key}-desc" class="text-sm text-muted-foreground">
					{TRIGGER_COPY[key].description}
				</p>
			</div>
			<!-- Pulled right so the centred Push switches line up with the switches below. -->
			<div class="-mr-1.5 flex shrink-0 gap-2">
				{#each CHANNELS as channel (channel.id)}
					<div
						class={[
							'flex w-14 justify-center',
							channel.id === 'push' && pushNowhere && 'opacity-60'
						]}
					>
						<Switch
							aria-label={channel.name}
							checked={triggerOn(channel, key)}
							onCheckedChange={(checked) => setTrigger(channel, key, checked)}
						/>
					</div>
				{/each}
			</div>
		</div>
	{/each}
	<dl
		class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 border-t border-border/60 pt-4 text-sm text-muted-foreground"
	>
		<dt class="font-medium text-foreground">Open tab</dt>
		<dd>
			A pop-up, sound or title flash while Chatty is open in a browser or app window.
			{#if desktopBlocked}
				Pop-ups can't show on this device (see below).
			{:else if !prefs.desktop || permission !== 'granted'}
				<button
					type="button"
					class="rounded-sm font-medium text-foreground underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring/50"
					onclick={() => showSwitch('pref-desktop')}>Turn on pop-ups below</button
				>
			{/if}
		</dd>
		<dt class="font-medium text-foreground">Push</dt>
		<dd>
			Sent to your phone or computer while Chatty is closed or you've stepped away.
			{#if pushReady && pushUnavailable}
				{pushOnElsewhere
					? "Push isn't available on this device (see below)."
					: "No device gets push yet, and this one can't (see below). Turn it on in Chatty on your phone."}
			{:else if pushReady && !pushOnHere}
				{pushOnElsewhere ? 'Push is off on this device.' : 'No device gets push yet.'}
				<button
					type="button"
					class="rounded-sm font-medium text-foreground underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring/50"
					onclick={() => showSwitch('pref-push')}>Turn it on below</button
				>
			{/if}
		</dd>
	</dl>
</SettingsSection>

<PushNotificationsSection
	bind:enabled={pushOnHere}
	bind:ready={pushReady}
	bind:unavailable={pushUnavailable}
/>

<SettingsSection title="On this device">
	{#snippet description()}
		Saved in this browser only.
		{#if !canTest}
			<!-- Touch screens never show the tooltip on the disabled button. -->
			<span class="pointer-fine:hidden"
				>Turn on device notifications or a sound to send a test.</span
			>
		{/if}
	{/snippet}
	{#snippet action()}
		<span title={canTest ? undefined : 'Turn on device notifications or a sound first'}>
			<Button variant="outline" size="sm" onclick={sendTest} disabled={!canTest}>
				<BellRingIcon class="size-4" />
				Test pop-up
			</Button>
		</span>
	{/snippet}
	<SettingsRow label="Pop-up notifications" for="pref-desktop">
		{#snippet description()}
			<span class={desktopBlocked ? 'text-amber-700 dark:text-amber-400' : undefined}
				>{desktopHint}</span
			>
		{/snippet}
		<Switch
			id="pref-desktop"
			checked={prefs.desktop && permission === 'granted'}
			disabled={desktopBlocked}
			onCheckedChange={setDesktop}
		/>
	</SettingsRow>
	<!-- Phones have no visible tab title to flash. -->
	<SettingsRow
		class="pointer-coarse:hidden"
		label="Flash the tab title"
		for="pref-flash"
		description="Alternate the title of a background tab until you come back."
	>
		<Switch
			id="pref-flash"
			checked={prefs.titleFlash}
			onCheckedChange={(checked) => update({ titleFlash: checked })}
		/>
	</SettingsRow>
	<SettingsRow
		label="Unread badges"
		for="pref-badge"
		description="Show the count in the tab title, a dot on the tab icon and a badge on the installed app."
	>
		<Switch
			id="pref-badge"
			checked={prefs.badge}
			onCheckedChange={(checked) => update({ badge: checked })}
		/>
	</SettingsRow>
	<SettingsRow
		label="Play a sound"
		for="pref-sound"
		description="A short sound when something needs your attention. Off by default."
	>
		<Switch
			id="pref-sound"
			checked={prefs.sound}
			onCheckedChange={(checked) => {
				update({ sound: checked });
				if (checked) playTone(prefs.tone, prefs.volume);
			}}
		/>
	</SettingsRow>

	{#if prefs.sound}
		<div class="flex flex-col gap-4 rounded-xl bg-muted/50 p-4">
			<SettingsRow label="Tone" for="pref-tone" stack>
				<Select.Root
					type="single"
					value={prefs.tone}
					onValueChange={(value) => {
						update({ tone: value as SoundTone });
						playTone(value as SoundTone, prefs.volume);
					}}
				>
					<Select.Trigger id="pref-tone" class="w-full bg-background sm:w-48">
						{SOUND_TONE_LABEL[prefs.tone]}
					</Select.Trigger>
					<Select.Content>
						{#each SOUND_TONES as tone (tone)}
							<Select.Item value={tone}>{SOUND_TONE_LABEL[tone]}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</SettingsRow>
			<SettingsRow label="Volume" for="pref-volume" stack>
				<div class="flex w-full items-center gap-3 sm:w-48">
					<input
						id="pref-volume"
						type="range"
						min="0"
						max="100"
						step="5"
						class="w-full accent-primary"
						value={Math.round(prefs.volume * 100)}
						oninput={(e) => update({ volume: Number(e.currentTarget.value) / 100 })}
						onchange={() => playTone(prefs.tone, prefs.volume)}
					/>
					<span class="w-10 shrink-0 text-right text-sm text-muted-foreground tabular-nums"
						>{Math.round(prefs.volume * 100)}%</span
					>
				</div>
			</SettingsRow>
			<SettingsRow
				label="Also while Chatty is focused"
				for="pref-sound-focused"
				description="By default the sound only plays when you're in another app or tab."
			>
				<Switch
					id="pref-sound-focused"
					checked={prefs.soundWhenFocused}
					onCheckedChange={(checked) => update({ soundWhenFocused: checked })}
				/>
			</SettingsRow>
		</div>
	{/if}
</SettingsSection>
