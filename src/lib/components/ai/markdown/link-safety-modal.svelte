<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';

	type Props = {
		url: string;
		isOpen: boolean;
		onClose: () => void;
		onConfirm: () => void;
	};

	let { url, isOpen, onClose, onConfirm }: Props = $props();

	let isCopied = $state(false);
	let copyTimeout: ReturnType<typeof setTimeout> | undefined;

	const displayUrl = $derived.by(() => {
		try {
			return new URL(url).hostname;
		} catch {
			return url;
		}
	});

	async function handleCopy() {
		try {
			await navigator.clipboard.writeText(url);
			isCopied = true;
			clearTimeout(copyTimeout);
			copyTimeout = setTimeout(() => (isCopied = false), 2000);
		} catch {
			// clipboard unavailable
		}
	}

	function handleOpenChange(open: boolean) {
		if (!open) {
			onClose();
		}
	}

	function handleConfirm() {
		onConfirm();
		onClose();
	}
</script>

<Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Open external link?</Dialog.Title>
			<Dialog.Description>
				You're about to leave this app and visit an external site. Make sure you trust
				<strong class="font-medium text-foreground">{displayUrl}</strong> before continuing.
			</Dialog.Description>
		</Dialog.Header>

		<div
			class="max-h-32 overflow-y-auto rounded-2xl border border-border bg-muted/50 p-3 font-mono text-xs break-all text-muted-foreground"
		>
			{url}
		</div>

		<Dialog.Footer class="gap-2 sm:gap-2">
			<Button variant="outline" class="flex-1" onclick={() => void handleCopy()}>
				{#if isCopied}
					<CheckIcon />
					Copied
				{:else}
					<CopyIcon />
					Copy link
				{/if}
			</Button>
			<Button class="flex-1" onclick={handleConfirm}>
				<ExternalLinkIcon />
				Open link
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
