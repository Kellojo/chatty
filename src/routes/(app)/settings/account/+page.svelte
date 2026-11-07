<script lang="ts">
	import { setMode } from 'mode-watcher';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsRow from '$lib/components/app/settings/SettingsRow.svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { THEMES, TIME_FORMATS, type Theme, type TimeFormat } from '$lib/user-settings.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const themeLabels: Record<Theme, string> = {
		light: 'Light',
		dark: 'Dark',
		system: 'System'
	};

	const timeFormatLabels: Record<TimeFormat, string> = {
		auto: 'Automatic',
		'12h': '12-hour',
		'24h': '24-hour'
	};

	let theme = $state<Theme>(data.settings.theme);
	let themeBusy = $state(false);

	let timeFormat = $state<TimeFormat>(data.settings.timeFormat);
	let timeFormatBusy = $state(false);

	async function putSettings(body: { theme?: Theme; timeFormat?: TimeFormat }) {
		const res = await fetch('/api/user/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			const payload = (await res.json().catch(() => null)) as { message?: string } | null;
			throw new Error(payload?.message ?? `Request failed (${res.status})`);
		}
	}

	async function changeTheme(value: Theme) {
		if (themeBusy || value === theme) return;
		const previous = theme;
		theme = value;
		setMode(value);
		themeBusy = true;
		try {
			await putSettings({ theme: value });
		} catch (e) {
			theme = previous;
			setMode(previous);
			toast.error(e instanceof Error ? e.message : 'Failed to update theme');
		} finally {
			themeBusy = false;
		}
	}

	async function changeTimeFormat(value: TimeFormat) {
		if (timeFormatBusy || value === timeFormat) return;
		const previous = timeFormat;
		timeFormat = value;
		timeFormatBusy = true;
		try {
			await putSettings({ timeFormat: value });
		} catch (e) {
			timeFormat = previous;
			toast.error(e instanceof Error ? e.message : 'Failed to update time format');
		} finally {
			timeFormatBusy = false;
		}
	}

	let passwordDialogOpen = $state(false);
	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmNewPassword = $state('');
	let passwordBusy = $state(false);

	function openPasswordDialog() {
		currentPassword = '';
		newPassword = '';
		confirmNewPassword = '';
		passwordDialogOpen = true;
	}

	async function submitPassword(event: SubmitEvent) {
		event.preventDefault();
		if (passwordBusy || !currentPassword || !newPassword || newPassword !== confirmNewPassword) {
			toast.error('Please fill in all fields and ensure passwords match.');
			return;
		}
		passwordBusy = true;
		try {
			const res = await fetch('/api/user/password', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ currentPassword, newPassword })
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(payload?.message ?? `Request failed (${res.status})`);
			}
			toast.success('Password updated');
			passwordDialogOpen = false;
			currentPassword = '';
			newPassword = '';
			confirmNewPassword = '';
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update password');
		} finally {
			passwordBusy = false;
		}
	}
</script>

<svelte:head><title>Account · Settings · Chatty</title></svelte:head>

<SettingsHeader title="Account" description="Personal preferences for your account." />

<SettingsSection title="Appearance" description="Choose how the app looks.">
	<SettingsRow
		label="Theme"
		for="pref-theme"
		description="Light, dark, or follow your system setting."
		stack
	>
		<Select.Root type="single" value={theme} onValueChange={(value) => changeTheme(value as Theme)}>
			<Select.Trigger id="pref-theme" class="w-full sm:w-48" disabled={themeBusy}>
				{themeLabels[theme]}
			</Select.Trigger>
			<Select.Content>
				{#each THEMES as option (option)}
					<Select.Item value={option}>{themeLabels[option]}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</SettingsRow>
	<SettingsRow
		label="Time format"
		for="pref-time-format"
		description="How times are shown. Automatic follows your browser locale."
		stack
	>
		<Select.Root
			type="single"
			value={timeFormat}
			onValueChange={(value) => changeTimeFormat(value as TimeFormat)}
		>
			<Select.Trigger id="pref-time-format" class="w-full sm:w-48" disabled={timeFormatBusy}>
				{timeFormatLabels[timeFormat]}
			</Select.Trigger>
			<Select.Content>
				{#each TIME_FORMATS as option (option)}
					<Select.Item value={option}>{timeFormatLabels[option]}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</SettingsRow>
</SettingsSection>

<SettingsSection title="Security" description="How you sign in to Chatty.">
	<SettingsRow label="Password" description="Change the password you sign in with." stack>
		<Button variant="outline" class="w-full sm:w-auto" onclick={openPasswordDialog}>
			Change password
		</Button>
	</SettingsRow>
</SettingsSection>

<Dialog.Root
	open={passwordDialogOpen}
	onOpenChange={(open) => {
		passwordDialogOpen = open;
		if (!open) {
			currentPassword = '';
			newPassword = '';
			confirmNewPassword = '';
		}
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Change password</Dialog.Title>
			<Dialog.Description>Use at least 8 characters.</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={submitPassword} class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="dialog-current-password">Current password</Label>
				<Input
					id="dialog-current-password"
					type="password"
					bind:value={currentPassword}
					required
					placeholder="Enter current password"
					autocomplete="current-password"
				/>
			</div>
			<div class="flex flex-col gap-2">
				<Label for="dialog-new-password">New password</Label>
				<Input
					id="dialog-new-password"
					type="password"
					bind:value={newPassword}
					required
					minlength={8}
					placeholder="At least 8 characters"
					autocomplete="new-password"
				/>
			</div>
			<div class="flex flex-col gap-2">
				<Label for="dialog-confirm-new-password">Confirm new password</Label>
				<Input
					id="dialog-confirm-new-password"
					type="password"
					bind:value={confirmNewPassword}
					required
					minlength={8}
					placeholder="Re-enter new password"
					autocomplete="new-password"
				/>
			</div>
			<Dialog.Footer>
				<Button type="submit" disabled={passwordBusy}>
					{passwordBusy ? 'Saving…' : 'Change password'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
