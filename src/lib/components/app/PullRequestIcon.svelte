<script lang="ts">
	import GitPullRequestIcon from '@lucide/svelte/icons/git-pull-request';
	import GitPullRequestDraftIcon from '@lucide/svelte/icons/git-pull-request-draft';
	import GitPullRequestClosedIcon from '@lucide/svelte/icons/git-pull-request-closed';
	import GitMergeIcon from '@lucide/svelte/icons/git-merge';
	import type { CodingPullRequestState } from '$lib/coding-environments.js';
	import { CODING_PR_STATE_STYLE } from '$lib/coding-status.js';

	let { state, class: className = '' }: { state: CodingPullRequestState | null; class?: string } =
		$props();

	const Icon = $derived(
		state === 'merged'
			? GitMergeIcon
			: state === 'closed'
				? GitPullRequestClosedIcon
				: state === 'draft'
					? GitPullRequestDraftIcon
					: GitPullRequestIcon
	);
</script>

<!-- Unknown state keeps the plain, untinted icon. -->
<Icon class="{state ? CODING_PR_STATE_STYLE[state].tone : ''} {className}" aria-hidden="true" />
