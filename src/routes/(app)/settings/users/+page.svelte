<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import ShieldOffIcon from '@lucide/svelte/icons/shield-off';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsListItem from '$lib/components/app/settings/SettingsListItem.svelte';
	import RowMenu, { type RowMenuItem } from '$lib/components/app/settings/RowMenu.svelte';
	import UserAvatar from '$lib/components/app/UserAvatar.svelte';
	import { formatDateTime } from '$lib/datetime.js';
	import type { AdminUser, UserRole } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const roleLabels: Record<UserRole, string> = { user: 'User', admin: 'Admin' };
	const methodLabels: Record<string, string> = { credential: 'Password', oidc: 'SSO' };

	const adminCount = $derived(data.users.filter((user) => user.role === 'admin').length);
	const isSelf = (user: AdminUser) => user.id === data.user.id;
	const isLastAdmin = (user: AdminUser) => user.role === 'admin' && adminCount <= 1;

	async function api(path: string, method: string, body?: unknown): Promise<Response> {
		const res = await fetch(path, {
			method,
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		if (!res.ok) {
			const payload = (await res.json().catch(() => null)) as { message?: string } | null;
			throw new Error(payload?.message ?? `Request failed (${res.status})`);
		}
		return res;
	}

	function patchUser(user: AdminUser, body: Record<string, unknown>) {
		return api(`/api/users/${encodeURIComponent(user.id)}`, 'PATCH', body);
	}

	function menuItems(user: AdminUser): RowMenuItem[] {
		const items: RowMenuItem[] = [
			{ label: 'Edit', icon: PencilIcon, onSelect: () => openEdit(user) }
		];
		if (isSelf(user)) return items;
		items.push(
			user.role === 'admin'
				? {
						label: 'Remove admin',
						icon: ShieldOffIcon,
						disabled: isLastAdmin(user),
						onSelect: () => changeRole(user, 'user')
					}
				: { label: 'Make admin', icon: ShieldIcon, onSelect: () => changeRole(user, 'admin') }
		);
		if (data.passwordLogin) {
			items.push({
				label: user.hasPassword ? 'Reset password' : 'Set password',
				icon: KeyRoundIcon,
				onSelect: () => openPassword(user)
			});
		}
		items.push(
			{ label: 'Sign out everywhere', icon: LogOutIcon, onSelect: () => signOutUser(user) },
			'separator',
			{
				label: 'Delete',
				icon: Trash2Icon,
				destructive: true,
				disabled: isLastAdmin(user),
				onSelect: () => openDelete(user)
			}
		);
		return items;
	}

	function metaLine(user: AdminUser): string {
		const methods = user.signInMethods.map((m) => methodLabels[m] ?? m).join(', ');
		const active = user.lastActiveAt
			? `Last active ${formatDateTime(user.lastActiveAt, data.timeFormat)}`
			: 'Never signed in';
		return [user.email, methods, active].filter(Boolean).join(' · ');
	}

	async function changeRole(user: AdminUser, role: UserRole) {
		try {
			await patchUser(user, { role });
			toast.success(
				role === 'admin' ? `${user.name} is now an admin` : `${user.name} is no longer an admin`
			);
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to change role');
		}
	}

	async function signOutUser(user: AdminUser) {
		try {
			await patchUser(user, { signOut: true });
			toast.success(`Signed ${user.name} out on every device`);
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to sign out user');
		}
	}

	// Add
	let addOpen = $state(false);
	let addName = $state('');
	let addEmail = $state('');
	let addPassword = $state('');
	let addRole = $state<UserRole>('user');
	let addBusy = $state(false);

	function openAdd() {
		addName = '';
		addEmail = '';
		addPassword = '';
		addRole = 'user';
		addOpen = true;
	}

	async function submitAdd(event: SubmitEvent) {
		event.preventDefault();
		if (addBusy) return;
		addBusy = true;
		try {
			await api('/api/users', 'POST', {
				name: addName,
				email: addEmail,
				password: addPassword,
				role: addRole
			});
			toast.success(`Added ${addName.trim()}`);
			addOpen = false;
			addPassword = '';
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to add user');
		} finally {
			addBusy = false;
		}
	}

	// Edit
	let editOpen = $state(false);
	let editTarget = $state<AdminUser | null>(null);
	let editName = $state('');
	let editRole = $state<UserRole>('user');
	let editBusy = $state(false);

	function openEdit(user: AdminUser) {
		editTarget = user;
		editName = user.name;
		editRole = user.role;
		editOpen = true;
	}

	async function submitEdit(event: SubmitEvent) {
		event.preventDefault();
		if (!editTarget || editBusy) return;
		const body: Record<string, unknown> = {};
		if (editName.trim() !== editTarget.name) body.name = editName;
		if (editRole !== editTarget.role) body.role = editRole;
		if (Object.keys(body).length === 0) {
			editOpen = false;
			return;
		}
		editBusy = true;
		try {
			await patchUser(editTarget, body);
			toast.success('User updated');
			editOpen = false;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update user');
		} finally {
			editBusy = false;
		}
	}

	// Password
	let passwordOpen = $state(false);
	let passwordTarget = $state<AdminUser | null>(null);
	let password = $state('');
	let passwordBusy = $state(false);

	function openPassword(user: AdminUser) {
		passwordTarget = user;
		password = '';
		passwordOpen = true;
	}

	async function submitPassword(event: SubmitEvent) {
		event.preventDefault();
		if (!passwordTarget || passwordBusy) return;
		passwordBusy = true;
		try {
			await patchUser(passwordTarget, { password });
			toast.success(`Password updated for ${passwordTarget.name}`);
			passwordOpen = false;
			password = '';
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to set password');
		} finally {
			passwordBusy = false;
		}
	}

	// Delete
	let deleteOpen = $state(false);
	let deleteTarget = $state<AdminUser | null>(null);
	let deleteBusy = $state(false);

	function openDelete(user: AdminUser) {
		deleteTarget = user;
		deleteOpen = true;
	}

	async function confirmDelete() {
		if (!deleteTarget || deleteBusy) return;
		deleteBusy = true;
		try {
			await api(`/api/users/${encodeURIComponent(deleteTarget.id)}`, 'DELETE');
			toast.success(`Deleted ${deleteTarget.name}`);
			deleteOpen = false;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to delete user');
		} finally {
			deleteBusy = false;
		}
	}
</script>

<svelte:head><title>Users · Settings · Chatty</title></svelte:head>

<SettingsHeader title="Users" description="Everyone with an account on this Chatty instance.">
	{#snippet actions()}
		{#if data.passwordLogin}
			<Button onclick={openAdd}><PlusIcon class="size-4" />Add user</Button>
		{/if}
	{/snippet}
</SettingsHeader>

<SettingsSection
	title="Accounts"
	description={`${data.users.length} ${data.users.length === 1 ? 'user' : 'users'}, ${adminCount} ${adminCount === 1 ? 'admin' : 'admins'}. Admins can manage models, providers, MCP servers and users.`}
	flush
>
	<ul class="divide-y divide-border/60" aria-label="Users">
		{#each data.users as user (user.id)}
			<SettingsListItem title={user.name} onclick={() => openEdit(user)}>
				{#snippet leading()}
					<UserAvatar name={user.name} image={user.image} class="size-8" />
				{/snippet}
				{#snippet badges()}
					{#if isSelf(user)}
						<Badge variant="outline">You</Badge>
					{/if}
					{#if user.role === 'admin'}
						<Badge variant="secondary"><ShieldIcon class="size-3" />Admin</Badge>
					{/if}
				{/snippet}
				{#snippet meta()}
					<span title={user.email}>{metaLine(user)}</span>
				{/snippet}
				{#snippet trailing()}
					<RowMenu label="Actions for {user.name}" items={menuItems(user)} />
				{/snippet}
			</SettingsListItem>
		{/each}
	</ul>
</SettingsSection>

<Dialog.Root bind:open={addOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Add user</Dialog.Title>
			<Dialog.Description>
				They sign in with this email and password. Share the password with them securely.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={submitAdd} class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="add-user-name">Name</Label>
				<Input id="add-user-name" bind:value={addName} required autocomplete="off" />
			</div>
			<div class="flex flex-col gap-2">
				<Label for="add-user-email">Email</Label>
				<Input id="add-user-email" type="email" bind:value={addEmail} required autocomplete="off" />
			</div>
			<div class="flex flex-col gap-2">
				<Label for="add-user-password">Password</Label>
				<Input
					id="add-user-password"
					type="password"
					bind:value={addPassword}
					required
					minlength={8}
					placeholder="At least 8 characters"
					autocomplete="new-password"
				/>
			</div>
			<div class="flex flex-col gap-2">
				<Label for="add-user-role">Role</Label>
				<Select.Root type="single" bind:value={addRole}>
					<Select.Trigger id="add-user-role" class="w-full">{roleLabels[addRole]}</Select.Trigger>
					<Select.Content>
						<Select.Item value="user">User</Select.Item>
						<Select.Item value="admin">Admin</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>
			<Dialog.Footer>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button {...props} type="button" variant="outline">Cancel</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={addBusy}>{addBusy ? 'Adding…' : 'Add user'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={editOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Edit {editTarget?.name ?? 'user'}</Dialog.Title>
			<Dialog.Description>{editTarget?.email}</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={submitEdit} class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="edit-user-name">Name</Label>
				<Input id="edit-user-name" bind:value={editName} required autocomplete="off" />
			</div>
			<div class="flex flex-col gap-2">
				<Label for="edit-user-role">Role</Label>
				<Select.Root
					type="single"
					bind:value={editRole}
					disabled={!editTarget || isSelf(editTarget) || isLastAdmin(editTarget)}
				>
					<Select.Trigger
						id="edit-user-role"
						class="w-full"
						disabled={!editTarget || isSelf(editTarget) || isLastAdmin(editTarget)}
					>
						{roleLabels[editRole]}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="user">User</Select.Item>
						<Select.Item value="admin">Admin</Select.Item>
					</Select.Content>
				</Select.Root>
				{#if editTarget && isSelf(editTarget)}
					<p class="text-xs text-muted-foreground">You can't change your own role.</p>
				{:else if editTarget && isLastAdmin(editTarget)}
					<p class="text-xs text-muted-foreground">The only admin can't be demoted.</p>
				{/if}
			</div>
			<Dialog.Footer>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button {...props} type="button" variant="outline">Cancel</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={editBusy}>{editBusy ? 'Saving…' : 'Save'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={passwordOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>
				{passwordTarget?.hasPassword ? 'Reset' : 'Set'} password for {passwordTarget?.name}
			</Dialog.Title>
			<Dialog.Description>
				They'll be signed out on every device and can sign in with the new password.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={submitPassword} class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="user-new-password">New password</Label>
				<Input
					id="user-new-password"
					type="password"
					bind:value={password}
					required
					minlength={8}
					placeholder="At least 8 characters"
					autocomplete="new-password"
				/>
			</div>
			<Dialog.Footer>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button {...props} type="button" variant="outline">Cancel</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={passwordBusy}>
					{passwordBusy ? 'Saving…' : 'Set password'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={deleteOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete {deleteTarget?.name}?</Dialog.Title>
			<Dialog.Description>
				This permanently deletes their account along with their conversations, agents, API keys and
				settings. It can't be undone.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteOpen = false)}>Cancel</Button>
			<Button variant="destructive" disabled={deleteBusy} onclick={confirmDelete}>
				{deleteBusy ? 'Deleting…' : 'Delete user'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
