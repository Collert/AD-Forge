<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';
	import AccountButton from '$lib/components/AccountButton.svelte';
	import CartDrawer from '$lib/components/CartDrawer.svelte';
	import { shelf, watchShelfCount } from '$lib/storage/shelf.svelte';

	let { children, data } = $props();

	onMount(watchShelfCount);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>AD-Forge — Simple & Precision Making</title>
</svelte:head>

<header class="site-header">
	<div class="header-inner">
		<div class="header-left">
			<a class="brand" href="/">
				<div class="brand-mark">A</div>
				<div class="brand-text">
					<span class="brand-name">AD-Forge</span>
					<span class="brand-tag">Custom Making Lab by ad-bits</span>
				</div>
			</a>
			<div class="divider"></div>
			<nav class="main-nav">
				<a href="/make/fdm">Workbench</a>
				<a href="/library" class:current={page.url.pathname.startsWith('/library')}>My Designs</a>
				<a href="/#services">Services</a>
				<a href="/#quote">Materials Library</a>
			</nav>
		</div>
		<div class="header-right">
			<a
				class="shelf-link"
				class:active={page.url.pathname.startsWith('/shelf')}
				href="/shelf"
				aria-label={`Shelf, ${shelf.count} ${shelf.count === 1 ? 'model' : 'models'}`}
				title="Shelf"
			>
				<span class="shelf-icon">
					<span class="material-symbols-outlined">inventory_2</span>
					{#if shelf.count > 0}
						<span class="shelf-count">{shelf.count > 99 ? '99+' : shelf.count}</span>
					{/if}
				</span>
				<span class="shelf-label">Shelf</span>
			</a>
			<a class="btn-primary" href="/make/fdm">
				<span class="material-symbols-outlined icon-16">add_circle</span>
				<span>Start Order</span>
			</a>
			<AccountButton account={data.account} />
		</div>
	</div>
</header>

<main>
	{@render children?.()}
</main>

<CartDrawer />

<footer class="site-footer">
	<div class="footer-inner">
		<div class="footer-brand">
			<div class="footer-mark">A</div>
			<span class="brand-name">AD-Forge</span>
			<span class="footer-sub">• Custom Making &amp; Print Lab</span>
		</div>
		<div class="footer-meta">
			<span class="status"><span class="dot"></span>Lab Workshop Ready</span>
			<span>Friendly Support &amp; NDA Protected</span>
			<span>© 2025 AD-Forge</span>
		</div>
	</div>
</footer>

<style>
	.site-header {
		position: fixed;
		inset: 0 0 auto 0;
		z-index: 50;
		background: var(--surface-container-lowest);
		box-shadow: 0 1px 8px rgb(0 0 0 / 0.04);
	}

	.header-inner {
		height: 4rem;
		padding: 0 var(--gutter-desktop);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: var(--space-lg);
	}

	.brand {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.brand-mark {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-lg);
		background: var(--primary);
		color: var(--on-primary);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 20px;
		font-weight: 700;
		box-shadow: var(--shadow-sm);
	}

	.brand-text {
		display: flex;
		flex-direction: column;
	}

	.brand-name {
		font-size: 16px;
		line-height: 1;
		font-weight: 700;
		letter-spacing: -0.025em;
		color: var(--on-surface);
	}

	.brand-tag {
		margin-top: 2px;
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 14px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--on-surface-variant);
	}

	.divider {
		display: none;
		width: 1px;
		height: 1.5rem;
		background: var(--surface-container-highest);
	}

	.main-nav {
		display: none;
		align-items: center;
		gap: var(--space-xs);
	}

	.main-nav a {
		padding: var(--space-xs) var(--space-md);
		border-radius: var(--radius-md);
		color: var(--on-surface-variant);
		transition:
			background-color 0.15s ease,
			color 0.15s ease;
	}

	.main-nav a.current {
		background: var(--surface-container);
		color: var(--on-surface);
	}

	.main-nav a:hover {
		background: var(--surface-container);
		color: var(--on-surface);
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: var(--space-md);
	}

	.shelf-link {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		height: 2.25rem;
		padding: 0 var(--space-sm);
		border-radius: var(--radius-md);
		color: var(--on-surface-variant);
		font-weight: 500;
		transition:
			background-color 0.15s ease,
			color 0.15s ease;
	}

	.shelf-link:hover,
	.shelf-link.active {
		background: var(--surface-container);
		color: var(--on-surface);
	}

	.shelf-icon {
		position: relative;
		display: flex;
	}

	.shelf-icon .material-symbols-outlined {
		font-size: 22px;
	}

	.shelf-label {
		display: none;
	}

	.shelf-count {
		position: absolute;
		top: -0.45rem;
		right: -0.55rem;
		min-width: 1.125rem;
		height: 1.125rem;
		padding: 0 0.3rem;
		border-radius: 999px;
		border: 2px solid var(--surface-container-lowest);
		background: var(--primary);
		color: var(--on-primary);
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 700;
		line-height: 1.125rem;
		text-align: center;
		box-sizing: content-box;
	}

	.icon-16 {
		font-size: 16px;
	}

	main {
		width: 100%;
		min-height: 100vh;
		padding-top: 4rem;
		background: var(--background);
	}

	.site-footer {
		background: var(--surface-container-low);
		box-shadow: 0 -1px 4px rgb(0 0 0 / 0.02);
	}

	.footer-inner {
		padding: var(--space-lg) var(--gutter-desktop);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
	}

	.footer-brand {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.footer-mark {
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		background: var(--primary);
		color: var(--on-primary);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		font-weight: 700;
	}

	.footer-sub,
	.footer-meta {
		font-size: 12px;
		line-height: 16px;
		color: var(--on-surface-variant);
	}

	.footer-sub {
		margin-left: var(--space-sm);
	}

	.footer-meta {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		gap: var(--space-lg);
	}

	.status {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: var(--radius-full);
		background: var(--secondary);
	}

	@media (min-width: 768px) {
		.divider {
			display: block;
		}

		.main-nav {
			display: flex;
		}

		.shelf-label {
			display: inline;
		}

		.footer-inner {
			flex-direction: row;
		}
	}

	@media (max-width: 480px) {
		.brand-tag {
			display: none;
		}
	}
</style>
