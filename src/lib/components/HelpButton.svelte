<script lang="ts">
	import { settingHelp, type HelpKey } from '$lib/catalog/help';
	import { openHelp } from './help.svelte';

	/** "?" next to a setting title; opens the shared HelpDialog. */
	let { key }: { key: HelpKey } = $props();
</script>

<button
	type="button"
	class="help-button"
	aria-label={`What is ${settingHelp[key].title}?`}
	aria-haspopup="dialog"
	onclick={(e) => {
		// Keep the click from reaching a parent control (e.g. a toggle row).
		e.stopPropagation();
		openHelp.key = key;
	}}
>
	<span class="material-symbols-outlined" aria-hidden="true">help</span>
</button>

<style>
	.help-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 18px;
		height: 18px;
		margin-left: 2px;
		padding: 0;
		border: none;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--on-surface-variant);
		vertical-align: middle;
		cursor: pointer;
		transition:
			color 0.15s,
			background 0.15s;
	}

	.help-button:hover,
	.help-button:focus-visible {
		color: var(--primary);
		background: var(--primary-tint);
	}

	.help-button:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 1px;
	}

	.material-symbols-outlined {
		font-size: 15px;
		/* Upright regardless of the uppercase / letter-spaced captions it sits in. */
		letter-spacing: normal;
		text-transform: none;
	}
</style>
