<script lang="ts">
	import { MAX_LINE_QUANTITY, setQuantity, type CartLine } from '$lib/cart.svelte';

	/** − [qty] + for a cart line; typing a number works too. Going below 1 removes the line. */
	let { line, compact = false }: { line: CartLine; compact?: boolean } = $props();

	function commit(input: HTMLInputElement) {
		const value = Number(input.value);
		if (Number.isFinite(value) && value !== line.quantity) setQuantity(line.id, value);
		else input.value = String(line.quantity);
	}
</script>

<div class="stepper" class:compact>
	<button
		type="button"
		aria-label={line.quantity === 1 ? `Remove ${line.title}` : `Decrease quantity of ${line.title}`}
		onclick={() => setQuantity(line.id, line.quantity - 1)}
	>
		<span class="material-symbols-outlined">{line.quantity === 1 ? 'delete' : 'remove'}</span>
	</button>
	<input
		type="number"
		inputmode="numeric"
		min="0"
		max={MAX_LINE_QUANTITY}
		value={line.quantity}
		aria-label={`Quantity of ${line.title}`}
		onchange={(e) => commit(e.currentTarget)}
		onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
	/>
	<button
		type="button"
		aria-label={`Increase quantity of ${line.title}`}
		disabled={line.quantity >= MAX_LINE_QUANTITY}
		onclick={() => setQuantity(line.id, line.quantity + 1)}
	>
		<span class="material-symbols-outlined">add</span>
	</button>
</div>

<style>
	.stepper {
		display: inline-flex;
		align-items: stretch;
		overflow: hidden;
		border: 1px solid var(--surface-container-highest);
		border-radius: var(--radius-md);
		background: var(--surface-container-lowest);
	}

	button {
		display: grid;
		place-items: center;
		width: 28px;
		color: var(--on-surface-variant);
	}

	button:hover:not(:disabled) {
		background: var(--surface-container-low);
		color: var(--primary);
	}

	button:disabled {
		opacity: 0.4;
	}

	.material-symbols-outlined {
		font-size: 16px;
	}

	input {
		width: 3rem;
		border: none;
		border-inline: 1px solid var(--surface-container-high);
		background: transparent;
		font-family: var(--font-mono);
		font-size: 13px;
		font-weight: 600;
		text-align: center;
		color: var(--on-surface);
		appearance: textfield;
		-moz-appearance: textfield;
	}

	input::-webkit-inner-spin-button,
	input::-webkit-outer-spin-button {
		appearance: none;
		margin: 0;
	}

	input:focus {
		outline: 2px solid var(--primary);
		outline-offset: -2px;
	}

	.compact button {
		width: 32px;
	}

	.compact {
		flex: 1;
		justify-content: space-between;
	}

	.compact input {
		flex: 1;
	}
</style>
