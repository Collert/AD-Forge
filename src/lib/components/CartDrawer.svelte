<script lang="ts">
	import { onMount } from 'svelte';
	import { cart, cartQuantity, isRepricing, removeLine, restoreCart, type CartDiscount } from '$lib/cart.svelte';
	import QuantityStepper from './QuantityStepper.svelte';

	/** Floating cart summary plus a side panel to edit quantities, remove items and check out. */
	let panel = $state<HTMLDialogElement>();
	let quantity = $derived(cartQuantity());
	/** Items at regular price, as Shopify priced them. */
	let beforeDiscounts = $derived(cart.lines.reduce((sum, l) => sum + l.subtotal, 0));
	/** Every discount Shopify applied, line and order level, merged by name. */
	let discounts = $derived.by(() => {
		const byTitle = new Map<string, number>();
		for (const d of [...cart.lines.flatMap((l) => l.discounts), ...cart.orderDiscounts]) byTitle.set(d.title, (byTitle.get(d.title) ?? 0) + d.amount);
		return [...byTitle].map(([title, amount]): CartDiscount => ({ title, amount }));
	});
	/** Prices are being recalculated by Shopify after an edit. */
	let repricing = $derived(cart.syncing > 0 || cart.lines.some(isRepricing));

	onMount(() => {
		restoreCart();
	});

	$effect(() => {
		if (!panel) return;
		if (cart.open && !panel.open) panel.showModal();
		else if (!cart.open && panel.open) panel.close();
	});

	const money = (v: number) => `$${v.toFixed(2)}`;
</script>

{#if quantity > 0 && !cart.open}
	<button class="cart-bar" onclick={() => (cart.open = true)} aria-label={`Open cart, ${quantity} items`}>
		<span class="material-symbols-outlined">shopping_cart</span>
		<span class="bar-text"><strong>{quantity} {quantity === 1 ? 'item' : 'items'}</strong> · <span class:stale={repricing}>{money(cart.total)} {cart.currency}</span></span>
		<span class="bar-cta">View Cart<span class="material-symbols-outlined">chevron_right</span></span>
	</button>
{/if}

<dialog
	bind:this={panel}
	class="drawer"
	aria-labelledby="cart-title"
	onclose={() => (cart.open = false)}
	onclick={(e) => e.target === panel && panel?.close()}
>
	<div class="sheet">
		<header>
			<h2 id="cart-title">Your Cart</h2>
			<span class="count">{quantity} {quantity === 1 ? 'item' : 'items'}</span>
			<button class="close" aria-label="Close cart" onclick={() => panel?.close()}>
				<span class="material-symbols-outlined">close</span>
			</button>
		</header>

		{#if cart.error}
			<p class="error"><span class="material-symbols-outlined">error</span>{cart.error}</p>
		{/if}

		{#if cart.lines.length}
			<ul class="lines">
				{#each cart.lines as line (line.id)}
					<li class="line">
						<div class="thumb">
							{#if line.imageUrl}<img src={line.imageUrl} alt="" />{:else}<span class="material-symbols-outlined">deployed_code</span>{/if}
						</div>
						<div class="info">
							<span class="title" title={line.title}>{line.title}</span>
							{#if line.variantTitle}<span class="variant">{line.variantTitle}</span>{/if}
							<span class="unit">
								{#if !isRepricing(line) && line.discounts.length}
									<s>{money(line.unitPrice)}</s> {money(line.total / line.quantity)} each
								{:else}
									{money(line.unitPrice)} each
								{/if}
							</span>
							{#if !isRepricing(line)}
								{#each line.discounts as d (d.title)}
									<span class="discount"><span class="material-symbols-outlined">sell</span>{d.title} −{money(d.amount)}</span>
								{/each}
							{/if}
							<div class="line-controls">
								<QuantityStepper {line} />
								<button class="remove" onclick={() => removeLine(line.id)}>
									<span class="material-symbols-outlined">delete</span>Remove
								</button>
							</div>
						</div>
						<span class="line-total">
							{#if isRepricing(line)}
								<span class="spinner dark" aria-label="Updating price"></span>
							{:else}
								{#if line.total < line.subtotal}<s>{money(line.subtotal)}</s>{/if}
								{money(line.total)}
							{/if}
						</span>
					</li>
				{/each}
			</ul>
		{:else}
			<div class="empty">
				<span class="material-symbols-outlined">remove_shopping_cart</span>
				Your cart is empty.
			</div>
		{/if}

		<footer>
			<div class="sums" class:stale={repricing}>
				{#if discounts.length}
					<div class="row"><span>Items</span><span class="amount">{money(beforeDiscounts)}</span></div>
					{#each discounts as d (d.title)}
						<div class="row saving"><span>{d.title}</span><span class="amount">−{money(d.amount)}</span></div>
					{/each}
				{/if}
				<div class="total">
					<span>Subtotal</span>
					<span class="amount">{money(cart.total)} {cart.currency}</span>
				</div>
			</div>
			<p class="note">Taxes and shipping are calculated at checkout.</p>
			{#if cart.checkoutUrl && cart.lines.length}
				<a class="checkout" class:busy={cart.syncing > 0} href={cart.checkoutUrl} aria-disabled={cart.syncing > 0}>
					{#if cart.syncing > 0}<span class="spinner"></span>Updating…{:else}Checkout<span class="material-symbols-outlined">arrow_forward</span>{/if}
				</a>
			{/if}
			<button class="keep" onclick={() => panel?.close()}>Keep browsing</button>
		</footer>
	</div>
</dialog>

<style>
	.cart-bar {
		position: fixed;
		left: 50%;
		bottom: var(--space-lg);
		z-index: 40;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: var(--space-md);
		max-width: calc(100vw - 2rem);
		padding: var(--space-sm) var(--space-sm) var(--space-sm) var(--space-lg);
		border-radius: var(--radius-full);
		background: var(--on-surface);
		color: #fff;
		box-shadow: var(--shadow-md);
	}

	.bar-text {
		font-size: 13px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.bar-cta {
		display: inline-flex;
		align-items: center;
		padding: 0.375rem var(--space-sm) 0.375rem var(--space-md);
		border-radius: var(--radius-lg);
		background: var(--primary-container);
		font-weight: 600;
		white-space: nowrap;
	}

	.cart-bar:hover .bar-cta {
		background: var(--primary);
	}

	.bar-cta .material-symbols-outlined {
		font-size: 18px;
	}

	/* ---------- Drawer ---------- */
	.drawer {
		margin: 0 0 0 auto;
		width: min(26rem, 100vw);
		max-width: 100vw;
		height: 100dvh;
		max-height: 100dvh;
		padding: 0;
		border: none;
		background: var(--surface-container-lowest);
		color: var(--on-surface);
		box-shadow: var(--shadow-md);
	}

	.drawer[open] {
		animation: slide-in 0.2s ease-out;
	}

	.drawer::backdrop {
		background: rgb(15 23 42 / 0.4);
	}

	@keyframes slide-in {
		from {
			transform: translateX(100%);
		}
	}

	.sheet {
		height: 100%;
		display: flex;
		flex-direction: column;
	}

	header {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: var(--space-md) var(--space-lg);
		border-bottom: 1px solid var(--surface-container-high);
	}

	h2 {
		font-size: 17px;
		line-height: 24px;
		font-weight: 600;
	}

	.count {
		flex: 1;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--on-surface-variant);
	}

	.close {
		display: inline-flex;
		padding: 4px;
		border-radius: var(--radius-full);
		color: var(--on-surface-variant);
	}

	.close:hover {
		background: var(--surface-container-high);
		color: var(--on-surface);
	}

	.error {
		display: flex;
		gap: var(--space-sm);
		margin: var(--space-md) var(--space-lg) 0;
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-md);
		background: var(--error-container);
		color: var(--on-error-container);
		font-size: 13px;
	}

	.error .material-symbols-outlined {
		font-size: 18px;
	}

	.lines {
		flex: 1;
		overflow-y: auto;
		margin: 0;
		padding: var(--space-sm) var(--space-lg);
		list-style: none;
	}

	.line {
		display: grid;
		grid-template-columns: 4rem 1fr auto;
		gap: var(--space-md);
		padding: var(--space-md) 0;
		border-bottom: 1px solid var(--surface-container-high);
	}

	.thumb {
		width: 4rem;
		height: 4rem;
		display: grid;
		place-items: center;
		overflow: hidden;
		border-radius: var(--radius-md);
		background: var(--surface-container-low);
		color: var(--on-surface-variant);
	}

	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.info {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}

	.variant,
	.unit {
		font-size: 12px;
		color: var(--on-surface-variant);
	}

	.unit {
		font-family: var(--font-mono);
	}

	.line-controls {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		margin-top: var(--space-xs);
	}

	.remove {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: 12px;
		color: var(--on-surface-variant);
	}

	.remove:hover {
		color: var(--error);
	}

	.remove .material-symbols-outlined {
		font-size: 16px;
	}

	.line-total {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		font-family: var(--font-mono);
		font-weight: 600;
	}

	.line-total s {
		font-size: 12px;
	}

	.empty {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
		color: var(--on-surface-variant);
	}

	.empty .material-symbols-outlined {
		font-size: 40px;
		opacity: 0.5;
	}

	footer {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		padding: var(--space-md) var(--space-lg) var(--space-lg);
		border-top: 1px solid var(--surface-container-high);
		background: var(--surface-container-low);
	}

	.sums {
		display: flex;
		flex-direction: column;
		gap: 2px;
		transition: opacity 0.15s;
	}

	.stale {
		opacity: 0.5;
	}

	.row,
	.total {
		display: flex;
		justify-content: space-between;
		gap: var(--space-sm);
	}

	.row {
		font-size: 13px;
		color: var(--on-surface-variant);
	}

	.row.saving {
		color: var(--secondary);
	}

	.total {
		font-weight: 600;
	}

	.discount {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 12px;
		font-weight: 600;
		color: var(--secondary);
	}

	.discount .material-symbols-outlined {
		font-size: 14px;
	}

	s {
		color: var(--on-surface-variant);
		font-weight: 400;
	}

	.amount {
		font-family: var(--font-mono);
	}

	.note {
		font-size: 12px;
		color: var(--on-surface-variant);
	}

	.checkout {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
		padding: var(--space-sm);
		border-radius: var(--radius-md);
		background: var(--primary);
		color: var(--on-primary);
		font-weight: 600;
	}

	.checkout:hover {
		background: var(--primary-container);
	}

	.checkout.busy {
		opacity: 0.7;
		pointer-events: none;
	}

	.checkout .material-symbols-outlined {
		font-size: 18px;
	}

	.keep {
		padding: var(--space-xs);
		font-size: 13px;
		color: var(--on-surface-variant);
	}

	.keep:hover {
		color: var(--on-surface);
	}

	.spinner {
		width: 14px;
		height: 14px;
		border: 2px solid rgb(255 255 255 / 0.4);
		border-top-color: #fff;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	.spinner.dark {
		border-color: var(--surface-container-highest);
		border-top-color: var(--primary);
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
