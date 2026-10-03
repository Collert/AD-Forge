<script lang="ts">
	import { page } from '$app/state';
	import type { Account } from '$lib/server/customer-account';

	/** Top-right avatar: the customer's picture with an account menu, or a sign-in link. */
	let { account }: { account: Account | null } = $props();

	let open = $state(false);
	let imageFailed = $state(false);
	let root = $state<HTMLElement>();

	let initials = $derived(
		(account?.name || account?.email || '?')
			.split(/[\s@._-]+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((w) => w[0].toUpperCase())
			.join('')
	);
	let loginHref = $derived(`/account/login?returnTo=${encodeURIComponent(page.url.pathname + page.url.search)}`);

	$effect(() => {
		if (!open) return;
		const close = (e: Event) => {
			if (e instanceof KeyboardEvent ? e.key === 'Escape' : !root?.contains(e.target as Node)) open = false;
		};
		document.addEventListener('pointerdown', close);
		document.addEventListener('keydown', close);
		return () => {
			document.removeEventListener('pointerdown', close);
			document.removeEventListener('keydown', close);
		};
	});
</script>

{#if account}
	<div class="account" bind:this={root}>
		<button class="avatar" aria-haspopup="menu" aria-expanded={open} aria-label="Account menu" onclick={() => (open = !open)}>
			{#if account.imageUrl && !imageFailed}
				<img src={account.imageUrl} alt="" referrerpolicy="no-referrer" onerror={() => (imageFailed = true)} />
			{:else}
				<span class="initials">{initials}</span>
			{/if}
		</button>
		{#if open}
			<div class="menu" role="menu">
				<div class="who">
					{#if account.name}<span class="name">{account.name}</span>{/if}
					<span class="email">{account.email}</span>
				</div>
				<a role="menuitem" href="https://account.adbits.ca/profile" onclick={() => (open = false)}>
					<span class="material-symbols-outlined">person</span>My Account
				</a>
				<a role="menuitem" href="/library" onclick={() => (open = false)}>
					<span class="material-symbols-outlined">folder_special</span>My Designs
				</a>
				<a role="menuitem" href="https://account.adbits.ca/orders" onclick={() => (open = false)}>
					<span class="material-symbols-outlined">receipt_long</span>My Orders
				</a>
				<form method="POST" action="/account/logout" data-sveltekit-reload>
					<button role="menuitem" type="submit"><span class="material-symbols-outlined">logout</span>Sign Out</button>
				</form>
			</div>
		{/if}
	</div>
{:else}
	<a class="avatar" href={loginHref} data-sveltekit-reload aria-label="Sign in" title="Sign in">
		<span class="material-symbols-outlined">person</span>
	</a>
{/if}

<style>
	.account {
		position: relative;
	}

	.avatar {
		width: 2rem;
		height: 2rem;
		overflow: hidden;
		border-radius: 50%;
		background: var(--surface-container);
		color: var(--on-surface-variant);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.avatar:hover {
		color: var(--on-surface);
		box-shadow: 0 0 0 2px var(--primary-tint);
	}

	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.avatar .material-symbols-outlined {
		font-size: 18px;
	}

	.initials {
		font-size: 12px;
		font-weight: 600;
		color: var(--primary);
	}

	.menu {
		position: absolute;
		top: calc(100% + 0.5rem);
		right: 0;
		z-index: 60;
		min-width: 14rem;
		padding: var(--space-xs);
		border: 1px solid var(--surface-container-high);
		border-radius: var(--radius-lg);
		background: var(--surface-container-lowest);
		box-shadow: var(--shadow-md);
	}

	.who {
		display: flex;
		flex-direction: column;
		padding: var(--space-sm);
		border-bottom: 1px solid var(--surface-container-high);
		margin-bottom: var(--space-xs);
	}

	.name {
		font-weight: 600;
	}

	.email {
		font-size: 12px;
		color: var(--on-surface-variant);
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.menu a,
	.menu button {
		width: 100%;
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: var(--space-sm);
		border-radius: var(--radius-md);
		font-size: 13px;
		text-align: left;
	}

	.menu a:hover,
	.menu button:hover {
		background: var(--surface-container-low);
		color: var(--primary);
	}

	.menu .material-symbols-outlined {
		font-size: 18px;
	}
</style>
