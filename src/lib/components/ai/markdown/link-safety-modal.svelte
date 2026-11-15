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
	let openButton = $state<HTMLElement | null>(null);
	// Fades the URL box's bottom edge while more of a long URL is hidden below.
	let hasMoreBelow = $state(false);

	$effect(() => () => clearTimeout(copyTimeout));

	function trackOverflow(box: HTMLElement) {
		void url; // re-measure when the URL changes
		const update = () => {
			hasMoreBelow = box.scrollTop + box.clientHeight < box.scrollHeight - 1;
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(box);
		box.addEventListener('scroll', update, { passive: true });
		return () => {
			observer.disconnect();
			box.removeEventListener('scroll', update);
		};
	}

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
	<Dialog.Content
		class="sm:max-w-md"
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			openButton?.focus();
		}}
	>
		<Dialog.Header class="pr-10">
			<Dialog.Title>Open external link?</Dialog.Title>
			<Dialog.Description class="text-pretty">
				This link leaves the app and goes to
				<strong class="font-medium [overflow-wrap:anywhere] text-foreground">{displayUrl}</strong>.
				Only continue if you trust this site.
			</Dialog.Description>
		</Dialog.Header>

		<!-- Focusable so keyboard users can scroll long URLs. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			{@attach trackOverflow}
			tabindex="0"
			role="region"
			aria-label="Full link address"
			class="max-h-32 overflow-y-auto overscroll-contain rounded-2xl border border-border bg-muted/50 p-3 pb-4 font-mono text-xs break-all text-muted-foreground outline-none select-text focus-visible:ring-3 focus-visible:ring-ring/30"
			class:fade-bottom={hasMoreBelow}
		>
			{url}
		</div>

		<!-- Primary action first in the DOM so tab order matches the stacked mobile layout. -->
		<Dialog.Footer class="flex-col sm:flex-row-reverse">
			<Button bind:ref={openButton} class="sm:flex-1" onclick={handleConfirm}>
				<ExternalLinkIcon />
				Open link
			</Button>
			<Button variant="outline" class="sm:flex-1" onclick={() => void handleCopy()}>
				{#if isCopied}
					<CheckIcon />
					Copied
				{:else}
					<CopyIcon />
					Copy link
				{/if}
			</Button>
			<span class="sr-only" aria-live="polite">{isCopied ? 'Link copied to clipboard' : ''}</span>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	.fade-bottom {
		mask-image: linear-gradient(to bottom, black calc(100% - 2rem), transparent);
	}
</style>
