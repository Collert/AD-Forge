<script lang="ts">
	import { settingHelp, type SettingHelp } from '$lib/catalog/help';
	import { openHelp } from './help.svelte';

	/** The one modal explaining a setting; opened by any HelpButton. */
	let dialog = $state<HTMLDialogElement>();
	let help = $derived<SettingHelp | null>(openHelp.key ? settingHelp[openHelp.key] : null);

	$effect(() => {
		if (!dialog) return;
		if (help && !dialog.open) dialog.showModal();
		else if (!help && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="help-dialog-title"
	onclose={() => (openHelp.key = null)}
	onclick={(e) => {
		// A click on the backdrop lands on the dialog itself.
		if (e.target === dialog) dialog.close();
	}}
>
	{#if help}
		<div class="sheet">
			<header>
				<span class="material-symbols-outlined badge" aria-hidden="true">help</span>
				<h2 id="help-dialog-title">{help.title}</h2>
				<button type="button" class="close" aria-label="Close" onclick={() => dialog?.close()}>
					<span class="material-symbols-outlined" aria-hidden="true">close</span>
				</button>
			</header>
			{#each help.body as paragraph (paragraph)}
				<p>{paragraph}</p>
			{/each}
			{#if help.tip}
				<p class="tip"><span class="material-symbols-outlined" aria-hidden="true">lightbulb</span>{help.tip}</p>
			{/if}
		</div>
	{/if}
</dialog>

<style>
	dialog {
		width: min(440px, calc(100vw - 2rem));
		max-height: calc(100vh - 4rem);
		padding: 0;
		border: 1px solid var(--outline-variant);
		border-radius: var(--radius-lg);
		background: var(--surface-container-lowest);
		color: var(--on-surface);
		box-shadow: var(--shadow-md);
	}

	dialog::backdrop {
		background: rgb(15 23 42 / 0.4);
	}

	.sheet {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		padding: var(--space-md) var(--space-lg) var(--space-lg);
	}

	header {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.badge {
		font-size: 20px;
		color: var(--primary);
	}

	h2 {
		flex: 1;
		margin: 0;
		font-size: 16px;
		line-height: 24px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.close {
		display: inline-flex;
		padding: 4px;
		border: none;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--on-surface-variant);
		cursor: pointer;
	}

	.close:hover,
	.close:focus-visible {
		background: var(--surface-container-high);
		color: var(--on-surface);
	}

	p {
		margin: 0;
		font-size: 14px;
		line-height: 21px;
		color: var(--on-surface-variant);
	}

	.tip {
		display: flex;
		gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-md);
		background: var(--primary-tint);
		color: var(--on-surface);
	}

	.tip .material-symbols-outlined {
		flex-shrink: 0;
		font-size: 18px;
		color: var(--primary);
	}
</style>
