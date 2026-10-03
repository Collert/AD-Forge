<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { processes } from '$lib/catalog/config';
	import { addToCart, cart, lineFor } from '$lib/cart.svelte';
	import QuantityStepper from '$lib/components/QuantityStepper.svelte';
	import type { DesignStatus, DesignsResult, FinalizedDesign } from '$lib/server/designs';
	import { deletePart, listParts, type PartRecord } from '$lib/storage/parts';
	import { pendingUpload } from '$lib/upload.svelte';
	import { MODEL_ACCEPT as ACCEPT } from '$lib/viewer/formats';

	let { data } = $props();

	// ---------- Drafts (this browser's shelf) ----------

	let parts = $state.raw<PartRecord[]>([]);
	let draftsLoading = $state(true);
	let draftsError = $state('');
	let confirmingDelete = $state<string | null>(null);
	/** Object URLs for thumbnails, keyed by part id. */
	let thumbs = $state.raw<Record<string, string>>({});
	let fileInput = $state<HTMLInputElement>();

	async function refreshDrafts() {
		try {
			const next = await listParts();
			const urls: Record<string, string> = {};
			for (const part of next) if (part.thumbnail) urls[part.id] = URL.createObjectURL(part.thumbnail);
			revokeThumbs();
			thumbs = urls;
			parts = next;
		} catch (err) {
			draftsError = (err as Error).message || 'Could not read your drafts.';
		} finally {
			draftsLoading = false;
		}
	}

	function revokeThumbs() {
		for (const url of Object.values(thumbs)) URL.revokeObjectURL(url);
	}

	onMount(() => {
		refreshDrafts();
		const onVisible = () => document.visibilityState === 'visible' && refreshDrafts();
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			document.removeEventListener('visibilitychange', onVisible);
			revokeThumbs();
		};
	});

	async function removeDraft(part: PartRecord) {
		if (confirmingDelete !== part.id) {
			confirmingDelete = part.id;
			return;
		}
		confirmingDelete = null;
		await deletePart(part.id);
		await refreshDrafts();
	}

	function addFile(files: FileList | null | undefined) {
		const file = files?.[0];
		if (!file) return;
		pendingUpload.file = file;
		goto('/make/fdm');
	}

	function editHref(part: PartRecord) {
		const process = processById(part.processId);
		return `/make/${process && !process.comingSoon ? process.id : 'fdm'}?part=${part.id}`;
	}

	// ---------- Finalized designs (Shopify) ----------

	let finalized = $state.raw<DesignsResult | null>(null);
	/** Design ids being renewed right now. */
	let renewing = $state<string[]>([]);

	// Keeps showing the current list while a refreshed one loads (e.g. after renewing).
	$effect(() => {
		let live = true;
		Promise.resolve(data.finalized).then((result) => live && (finalized = result));
		return () => (live = false);
	});

	let designs = $derived(finalized?.designs ?? []);
	let tab = $state<'all' | DesignStatus>('all');

	const tabs: { id: 'all' | DesignStatus; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'active', label: 'Active' },
		{ id: 'expiring', label: 'Expiring Soon' },
		{ id: 'archived', label: 'Archived' }
	];

	let byStatus = $derived(
		designs.reduce<Record<DesignStatus, number>>(
			(acc, d) => ((acc[d.status] += 1), acc),
			{ active: 0, expiring: 0, archived: 0 }
		)
	);

	// ---------- Search & process filter (both sections) ----------

	let search = $state('');
	let filter = $state('all');

	const processById = (id: string | null) => processes.find((p) => p.id === id);

	let processCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const p of parts) counts[p.processId] = (counts[p.processId] ?? 0) + 1;
		for (const d of designs) if (d.processId) counts[d.processId] = (counts[d.processId] ?? 0) + 1;
		return counts;
	});
	let filters = $derived(processes.filter((p) => processCounts[p.id]));

	const matches = (q: string, ...fields: (string | null | undefined)[]) =>
		!q || fields.some((f) => f?.toLowerCase().includes(q));

	let visibleDrafts = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return parts.filter(
			(p) => (filter === 'all' || p.processId === filter) && matches(q, p.name, p.fileName, p.format, ...(p.summary?.specs.map((c) => c.label) ?? []))
		);
	});

	let visibleDesigns = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return designs.filter(
			(d) =>
				(tab === 'all' || d.status === tab) &&
				(filter === 'all' || d.processId === filter) &&
				matches(q, d.name, d.fileName, ...d.specs)
		);
	});

	// ---------- Cart & toasts ----------

	let toast = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	function notify(kind: 'ok' | 'error', text: string) {
		clearTimeout(toastTimer);
		toast = { kind, text };
		toastTimer = setTimeout(() => (toast = null), kind === 'error' ? 6000 : 3000);
	}

	async function add(design: FinalizedDesign) {
		if (!design.variantId) return;
		try {
			await addToCart(design.variantId);
			notify('ok', `${design.name} added to your cart.`);
		} catch (err) {
			notify('error', (err as Error).message);
		}
	}

	// ---------- Formatting ----------

	function dims(part: PartRecord) {
		const s = part.summary?.size;
		if (!s) return '';
		return `${s.x.toFixed(2)} × ${s.y.toFixed(2)} × ${s.z.toFixed(2)} mm`;
	}

	function edited(ts: number) {
		const mins = Math.round((Date.now() - ts) / 60000);
		if (mins < 1) return 'Edited just now';
		if (mins < 60) return `Edited ${mins}m ago`;
		const hrs = Math.round(mins / 60);
		if (hrs < 24) return `Edited ${hrs}h ago`;
		const days = Math.round(hrs / 24);
		return days < 30 ? `Edited ${days}d ago` : `Edited ${new Date(ts).toLocaleDateString()}`;
	}

	function draftStatus(part: PartRecord): { kind: 'ok' | 'warn' | 'idle'; label: string } {
		const s = part.summary;
		if (!s) return { kind: 'idle', label: 'Not Configured' };
		if (s.issues > 0) return { kind: 'warn', label: `${s.issues} ${s.issues === 1 ? 'Issue' : 'Issues'} to Review` };
		if (s.quotedTotal != null) return { kind: 'ok', label: 'Quote Validated' };
		return { kind: 'idle', label: 'Draft Saved' };
	}

	function lifeLabel(d: FinalizedDesign) {
		if (d.status === 'archived') {
			const ago = -d.daysLeft;
			return ago < 1 ? 'Expired (Archived)' : `Expired ${ago}d Ago`;
		}
		const days = `${d.daysLeft} ${d.daysLeft === 1 ? 'Day' : 'Days'} Left`;
		return d.status === 'expiring' ? `${days} (Expiring)` : days;
	}

	const money = (v: number) => `$${v.toFixed(2)}`;
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
</script>

<svelte:head>
	<title>My Designs — AD-Forge</title>
</svelte:head>

<section class="library">
	<!-- Title & stats -->
	<header class="top">
		<div class="intro">
			<h1>My Designs &amp; CAD Repository</h1>
			<p>
				Manage drafts and production-finalized parts. Finalized models remain saved for {data.retentionDays} days before automated
				deletion. Renewing a model here or placing an order resets its clock to {data.retentionDays} days.
			</p>
		</div>
		<div class="stats">
			<div class="stat">
				<span class="caps">Drafts In Progress</span>
				<span class="stat-line"><span class="stat-value">{draftsLoading ? '—' : parts.length}</span>Models</span>
			</div>
			<div class="stat">
				<span class="caps">Production Ready</span>
				<span class="stat-line"><span class="stat-value ready">{finalized ? byStatus.active + byStatus.expiring : '—'}</span>Models</span>
			</div>
			<div class="stat">
				<span class="caps">Nearing Archive</span>
				<span class="stat-line"><span class="stat-value warn">{finalized ? byStatus.expiring : '—'}</span>&lt; {data.expiringDays} Days</span>
			</div>
			<div class="stat">
				<span class="caps">Archived</span>
				<span class="stat-line"><span class="stat-value">{finalized ? byStatus.archived : '—'}</span>Models</span>
			</div>
		</div>
	</header>

	<!-- Search, filters, upload -->
	<div class="toolbar">
		<label class="search">
			<span class="material-symbols-outlined">search</span>
			<input type="search" placeholder="Search file name, material or setting…" bind:value={search} />
		</label>
		<div class="pills" role="group" aria-label="Filter by process">
			<button class:active={filter === 'all'} onclick={() => (filter = 'all')}>All ({parts.length + designs.length})</button>
			{#each filters as p (p.id)}
				<button class:active={filter === p.id} onclick={() => (filter = p.id)}>{p.badge} ({processCounts[p.id]})</button>
			{/each}
		</div>
		<button class="btn-upload" onclick={() => fileInput?.click()}>
			<span class="material-symbols-outlined">add_box</span>Upload New CAD / STL
		</button>
		<input bind:this={fileInput} type="file" accept={ACCEPT} hidden onchange={(e) => addFile(e.currentTarget.files)} />
	</div>

	<!-- Drafts -->
	<section class="group">
		<div class="group-head">
			<div class="group-title">
				<span class="material-symbols-outlined title-icon draft">edit_document</span>
				<h2>Draft Configurations</h2>
				<span class="count draft">({plural(parts.length, 'Draft')})</span>
			</div>
			<p class="group-note">Saved in this browser. Continue setup, get an accurate quote, then confirm to order.</p>
		</div>

		{#if draftsLoading}
			<div class="state"><span class="spinner"></span>Loading drafts…</div>
		{:else if draftsError}
			<div class="state"><span class="material-symbols-outlined error-text">error</span>{draftsError}</div>
		{:else if !parts.length}
			<div class="state">
				<span class="material-symbols-outlined">inventory_2</span>
				No drafts yet. Upload a model to start configuring it.
			</div>
		{:else if !visibleDrafts.length}
			<div class="state"><span class="material-symbols-outlined">filter_alt_off</span>No drafts match your search or filter.</div>
		{:else}
			<div class="grid">
				{#each visibleDrafts as part (part.id)}
					{@const process = processById(part.processId)}
					{@const s = part.summary}
					{@const status = draftStatus(part)}
					<article class="card">
						<div class="view">
							{#if thumbs[part.id]}
								<img src={thumbs[part.id]} alt="" loading="lazy" />
							{:else}
								<span class="material-symbols-outlined view-empty">deployed_code</span>
							{/if}
							<div class="tags">
								<span class="tag">{process?.badge ?? part.processId}</span>
								<span class="tag format">.{part.format.toUpperCase()}</span>
							</div>
							<a class="peek" href={editHref(part)} title="Open in the configurator" aria-label={`Open ${part.name}`}>
								<span class="material-symbols-outlined">visibility</span>
							</a>
							{#if dims(part)}<span class="dims">{dims(part)}</span>{/if}
						</div>
						<div class="body">
							<div class="name-row">
								<a class="name" href={editHref(part)} title={part.fileName}>{part.name}</a>
								<span class="when">{edited(part.updatedAt)}</span>
							</div>
							<div class="chips">
								{#each s?.specs ?? [] as chip (chip.label)}
									<span class="chip">{chip.label}</span>
								{:else}
									<span class="chip muted">Not configured yet</span>
								{/each}
							</div>
							<div class="dock">
								<div class="dock-line">
									<span class="status {status.kind}"><span class="dot"></span>{status.label}</span>
									{#if s?.quotedTotal != null}
										<span class="price">{money(s.quotedTotal)}</span>
									{:else if s}
										<span class="price">Est. {money(s.estimateTotal)}</span>
									{/if}
								</div>
								<div class="actions">
									<a class="btn-main" href={editHref(part)} title={s?.quotedTotal != null ? 'Confirm and upload for production' : 'Get an accurate quote in the configurator'}>
										<span class="material-symbols-outlined">cloud_upload</span>
										{s?.quotedTotal != null ? 'Confirm & Upload' : 'Get Quote'}
									</a>
									<a class="btn-icon" href={editHref(part)} title="Configure Parameters" aria-label="Configure Parameters">
										<span class="material-symbols-outlined">tune</span>
									</a>
									<button
										class="btn-icon danger"
										class:confirm={confirmingDelete === part.id}
										title={confirmingDelete === part.id ? 'Click again to delete' : 'Delete Draft'}
										aria-label="Delete Draft"
										onclick={() => removeDraft(part)}
										onblur={() => confirmingDelete === part.id && (confirmingDelete = null)}
									>
										<span class="material-symbols-outlined">{confirmingDelete === part.id ? 'delete_forever' : 'delete'}</span>
									</button>
								</div>
							</div>
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>

	<!-- Finalized -->
	<section class="group">
		<div class="group-head">
			<div class="group-title">
				<span class="material-symbols-outlined title-icon final">verified</span>
				<h2>Finalized Designs</h2>
				<span class="count final">({plural(designs.length, 'Part')})</span>
				<span class="sep">•</span>
				<span class="group-note">Reviewed and priced. Available for instant re-order.</span>
			</div>
			<div class="tabs" role="group" aria-label="Filter by retention">
				{#each tabs as t (t.id)}
					<button class:active={tab === t.id} onclick={() => (tab = t.id)}>
						{t.label} ({t.id === 'all' ? designs.length : byStatus[t.id]})
					</button>
				{/each}
			</div>
		</div>

		{#if !finalized}
			<div class="state"><span class="spinner"></span>Loading your finalized designs…</div>
		{:else if !finalized.ok && finalized.reason === 'signed-out'}
			<div class="state">
				<span class="material-symbols-outlined">lock</span>
				<span>Sign in to see your finalized designs and reorder them.</span>
				<a class="btn-main signin" href="/account/login?returnTo=/library" data-sveltekit-reload>
					<span class="material-symbols-outlined">login</span>Sign In
				</a>
			</div>
		{:else if !finalized.ok}
			<div class="state">
				<span class="material-symbols-outlined error-text">cloud_off</span>
				{finalized.reason === 'not-configured'
					? 'Finalized designs are not connected yet.'
					: "We couldn't load your finalized designs. Please try again shortly."}
			</div>
		{:else if !designs.length}
			<div class="state">
				<span class="material-symbols-outlined">verified</span>
				No finalized designs yet. Confirm a quoted draft and it will appear here once reviewed.
			</div>
		{:else if !visibleDesigns.length}
			<div class="state"><span class="material-symbols-outlined">filter_alt_off</span>No finalized designs match your search or filter.</div>
		{:else}
			<div class="grid">
				{#each visibleDesigns as design (design.id)}
					{@const process = processById(design.processId)}
					{@const adding = !!design.variantId && cart.adding.includes(design.variantId)}
					{@const inCart = design.variantId ? lineFor(design.variantId) : undefined}
					<article class="card" class:archived={design.status === 'archived'}>
						<div class="view photo">
							{#if design.imageUrl}
								<img src={design.imageUrl} alt="" loading="lazy" />
							{:else}
								<span class="material-symbols-outlined view-empty">deployed_code</span>
							{/if}
							<div class="tags">
								<span class="tag">{process?.badge ?? 'Custom'}</span>
								{#if design.format}<span class="tag format">.{design.format.toUpperCase()}</span>{/if}
							</div>
							<span class="life {design.status}">
								<span class="material-symbols-outlined">
									{design.status === 'active' ? 'hourglass_top' : design.status === 'expiring' ? 'warning' : 'do_not_disturb_on'}
								</span>
								{lifeLabel(design)}
							</span>
							{#if design.inProduction}<span class="dims">In production</span>{/if}
						</div>
						<div class="body">
							<div class="name-row">
								<span class="name" title={design.fileName ?? design.name}>{design.name}</span>
							</div>
							<div class="chips">
								{#each design.specs as spec (spec)}<span class="chip">{spec}</span>{/each}
							</div>
							{#if design.status !== 'archived'}
								<div class="dock">
									<div class="dock-line">
										<span class="caps">Batch Price</span>
										{#if design.price != null}
											<span class="price">{money(design.price)} <small>/ unit</small></span>
										{/if}
									</div>
									<div class="actions">
										{#if inCart}
											<QuantityStepper line={inCart} compact />
										{:else}
											<button
												class="btn-main"
												disabled={!design.variantId || !design.availableForSale || adding}
												onclick={() => add(design)}
											>
												{#if adding}
													<span class="btn-spinner"></span>Adding…
												{:else}
													<span class="material-symbols-outlined">add_shopping_cart</span>Add to Cart
												{/if}
											</button>
										{/if}
										<form
											method="POST"
											action="?/renew"
											use:enhance={() => {
												renewing = [...renewing, design.id];
												return async ({ result, update }) => {
													if (result.type === 'failure') notify('error', String(result.data?.message ?? 'Could not renew this design.'));
													else if (result.type === 'success') notify('ok', `${design.name} is saved for ${data.retentionDays} days from today.`);
													await update({ reset: false });
													renewing = renewing.filter((id) => id !== design.id);
												};
											}}
										>
											<input type="hidden" name="id" value={design.id} />
											{#if design.daysLeft >= data.retentionDays}
												<button class="btn-extend" disabled title={`Already saved for the full ${data.retentionDays} days`}>
													<span class="material-symbols-outlined">check</span>Saved {data.retentionDays}d
												</button>
											{:else}
												<button
													class="btn-extend"
													class:urgent={design.status === 'expiring'}
													disabled={renewing.includes(design.id)}
													title={`Reset the clock: keep this model for ${data.retentionDays} days from today`}
												>
													{#if renewing.includes(design.id)}
														<span class="btn-spinner dark"></span>Renewing…
													{:else}
														<span class="material-symbols-outlined">history</span>
														{design.status === 'expiring' ? 'Renew Now' : `Renew (${data.retentionDays}d)`}
													{/if}
												</button>
											{/if}
										</form>
									</div>
								</div>
							{/if}
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>
</section>

{#if toast}
	<div class="toast {toast.kind}" role="alert">
		<span class="material-symbols-outlined">{toast.kind === 'ok' ? 'check_circle' : 'error'}</span>
		{toast.text}
	</div>
{/if}

<style>
	.library {
		max-width: 90rem;
		margin: 0 auto;
		padding: var(--space-xl) var(--gutter-desktop) 6rem;
		display: flex;
		flex-direction: column;
		gap: var(--space-xl);
	}

	.caps {
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 14px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--on-surface-variant);
	}

	/* ---------- Title & stats ---------- */
	.top {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-lg);
	}

	.intro {
		max-width: 36rem;
	}

	.intro h1 {
		font-size: 28px;
		line-height: 36px;
		font-weight: 700;
		letter-spacing: -0.02em;
	}

	.intro p {
		margin-top: var(--space-xs);
		font-size: 15px;
		line-height: 24px;
		color: var(--on-surface-variant);
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-sm);
	}

	.stat {
		min-width: 9.5rem;
		padding: var(--space-md);
		border: 1px solid var(--surface-container-high);
		border-radius: var(--radius-lg);
		background: var(--surface-container-lowest);
		box-shadow: var(--shadow-sm);
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	.stat-line {
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
		font-size: 13px;
		color: var(--on-surface-variant);
	}

	.stat-value {
		font-family: var(--font-mono);
		font-size: 20px;
		line-height: 26px;
		font-weight: 600;
		color: var(--on-surface);
	}

	.stat-value.ready {
		color: var(--secondary);
	}

	.stat-value.warn {
		color: var(--primary);
	}

	/* ---------- Toolbar ---------- */
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-sm);
		padding: var(--space-sm);
		border-radius: var(--radius-lg);
		background: var(--surface-container-low);
	}

	.search {
		flex: 1 1 18rem;
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: 0.4375rem var(--space-md);
		border: 1px solid var(--surface-container-high);
		border-radius: var(--radius-md);
		background: var(--surface-container-lowest);
		color: var(--on-surface-variant);
	}

	.search .material-symbols-outlined {
		font-size: 18px;
	}

	.search input {
		flex: 1;
		min-width: 0;
		border: none;
		outline: none;
		background: transparent;
		font: inherit;
		color: var(--on-surface);
	}

	.search:focus-within {
		border-color: var(--primary);
	}

	.pills,
	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}

	.pills button,
	.tabs button {
		padding: 0.375rem var(--space-md);
		border: 1px solid var(--surface-container-high);
		border-radius: var(--radius-md);
		background: var(--surface-container-lowest);
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--on-surface-variant);
		transition:
			background 0.15s,
			color 0.15s;
	}

	.pills button:hover,
	.tabs button:hover {
		color: var(--on-surface);
	}

	.pills button.active {
		border-color: var(--primary);
		background: var(--primary);
		color: var(--on-primary);
	}

	.btn-upload {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: var(--space-sm);
		padding: 0.5rem var(--space-lg);
		border-radius: var(--radius-md);
		background: var(--primary);
		color: var(--on-primary);
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 600;
		box-shadow: var(--shadow-sm);
	}

	.btn-upload:hover {
		background: var(--primary-container);
	}

	.btn-upload .material-symbols-outlined {
		font-size: 18px;
	}

	/* ---------- Sections ---------- */
	.group {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}

	.group-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm) var(--space-lg);
		padding: var(--space-md) var(--space-md);
		border-radius: var(--radius-lg);
		background: var(--surface-container-low);
	}

	.group-title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-sm);
	}

	.group-title h2 {
		font-size: 17px;
		line-height: 24px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.title-icon {
		font-size: 22px;
	}

	.title-icon.draft {
		color: var(--primary);
	}

	.title-icon.final {
		color: var(--secondary);
	}

	.count {
		padding: 1px var(--space-sm);
		border-radius: var(--radius-full);
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 600;
	}

	.count.draft {
		background: var(--tertiary-fixed);
		color: var(--tertiary);
	}

	.count.final {
		background: var(--secondary-tint);
		color: var(--secondary);
	}

	.sep {
		color: var(--on-surface-variant);
	}

	.group-note {
		font-size: 13px;
		color: var(--on-surface-variant);
	}

	.tabs {
		padding: 3px;
		border-radius: var(--radius-md);
		background: var(--surface-container-lowest);
	}

	.tabs button {
		border-color: transparent;
		background: transparent;
		text-transform: none;
		letter-spacing: 0;
	}

	.tabs button.active {
		background: var(--secondary);
		color: #fff;
	}

	.state {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
		padding: var(--space-xl) var(--space-lg);
		border: 1px dashed var(--surface-container-highest);
		border-radius: var(--radius-lg);
		color: var(--on-surface-variant);
		text-align: center;
	}

	.signin {
		flex: 0 0 auto;
	}

	.error-text {
		color: var(--error);
	}

	/* ---------- Cards ---------- */
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
		gap: var(--space-md);
	}

	.card {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--surface-container-high);
		border-radius: var(--radius-lg);
		background: var(--surface-container-lowest);
		box-shadow: var(--shadow-sm);
		transition: box-shadow 0.15s;
	}

	.card:hover {
		box-shadow: var(--shadow-md);
	}

	.card.archived {
		opacity: 0.75;
	}

	.card.archived img {
		filter: grayscale(0.8);
	}

	.view {
		position: relative;
		aspect-ratio: 16 / 7;
		display: grid;
		place-items: center;
		background: linear-gradient(160deg, var(--surface-container-low), var(--surface-container-highest));
	}

	.view img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		padding: var(--space-md);
	}

	.view.photo img {
		object-fit: cover;
		padding: 0;
	}

	.view-empty {
		font-size: 48px;
		color: var(--on-surface-variant);
		opacity: 0.4;
	}

	.tags {
		position: absolute;
		top: var(--space-sm);
		left: var(--space-sm);
		display: flex;
		gap: var(--space-xs);
	}

	.tag {
		padding: 2px 0.375rem;
		border-radius: var(--radius-sm);
		background: rgb(255 255 255 / 0.92);
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--on-surface);
		box-shadow: var(--shadow-sm);
	}

	.tag.format {
		background: var(--surface-container-high);
		color: var(--on-surface-variant);
	}

	.peek {
		position: absolute;
		top: var(--space-sm);
		right: var(--space-sm);
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-full);
		background: rgb(255 255 255 / 0.92);
		color: var(--on-surface);
		box-shadow: var(--shadow-sm);
	}

	.peek:hover {
		color: var(--primary);
	}

	.peek .material-symbols-outlined {
		font-size: 17px;
	}

	.dims {
		position: absolute;
		left: var(--space-sm);
		bottom: var(--space-sm);
		padding: 1px 0.375rem;
		border-radius: var(--radius-sm);
		background: rgb(19 27 46 / 0.7);
		font-family: var(--font-mono);
		font-size: 11px;
		color: #fff;
	}

	.life {
		position: absolute;
		top: var(--space-sm);
		right: var(--space-sm);
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 2px 0.375rem;
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		box-shadow: var(--shadow-sm);
	}

	.life .material-symbols-outlined {
		font-size: 14px;
	}

	.life.active {
		background: var(--secondary-container);
		color: var(--on-secondary-container);
	}

	.life.expiring {
		background: var(--tertiary-fixed);
		color: var(--tertiary);
	}

	.life.archived {
		background: var(--surface-container-high);
		color: var(--on-surface-variant);
	}

	.body {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		padding: var(--space-md);
	}

	.name-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-sm);
	}

	.name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 15px;
		line-height: 22px;
		font-weight: 600;
	}

	a.name:hover {
		color: var(--primary);
	}

	.when {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--on-surface-variant);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}

	.chip {
		padding: 1px 0.375rem;
		border: 1px solid var(--surface-container-high);
		border-radius: var(--radius-sm);
		background: var(--surface-container-low);
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 18px;
		color: var(--on-surface-variant);
	}

	.chip.muted {
		font-style: italic;
	}

	.dock {
		margin-top: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		padding-top: var(--space-sm);
	}

	.dock-line {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
	}

	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		color: var(--on-surface-variant);
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--outline-variant);
	}

	.status.ok {
		color: var(--secondary);
	}

	.status.ok .dot {
		background: var(--secondary);
	}

	.status.warn {
		color: var(--tertiary);
	}

	.status.warn .dot {
		background: var(--tertiary);
	}

	.price {
		font-family: var(--font-mono);
		font-size: 15px;
		font-weight: 600;
	}

	.price small {
		font-size: 11px;
		font-weight: 400;
		color: var(--on-surface-variant);
	}

	.actions {
		display: flex;
		gap: var(--space-xs);
		padding: var(--space-xs);
		border-radius: var(--radius-md);
		background: var(--surface-container-low);
	}

	.actions form {
		display: contents;
	}

	.btn-main,
	.btn-extend {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		padding: 0.375rem var(--space-md);
		border-radius: var(--radius-md);
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 600;
		white-space: nowrap;
	}

	.btn-main {
		flex: 1;
		background: var(--primary);
		color: var(--on-primary);
	}

	.btn-main:hover:not(:disabled) {
		background: var(--primary-container);
	}

	.btn-main:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.btn-main .material-symbols-outlined,
	.btn-extend .material-symbols-outlined {
		font-size: 16px;
	}

	.btn-extend {
		border: 1px solid var(--surface-container-high);
		background: var(--surface-container-lowest);
		color: var(--on-surface);
	}

	.btn-extend:hover:not(:disabled) {
		border-color: var(--primary);
		color: var(--primary);
	}

	.btn-extend:disabled {
		color: var(--on-surface-variant);
		cursor: default;
	}

	.btn-extend.urgent {
		border-color: var(--primary-container);
		background: var(--primary-container);
		color: var(--on-primary);
	}

	.btn-extend.urgent:hover {
		background: var(--primary);
		color: var(--on-primary);
	}

	.btn-icon {
		display: grid;
		place-items: center;
		width: 32px;
		border-radius: var(--radius-md);
		background: var(--surface-container-lowest);
		color: var(--on-surface-variant);
	}

	.btn-icon:hover {
		color: var(--primary);
	}

	.btn-icon .material-symbols-outlined {
		font-size: 18px;
	}

	.btn-icon.danger:hover,
	.btn-icon.confirm {
		color: var(--error);
	}

	.btn-icon.confirm {
		background: var(--error-container);
	}

	/* ---------- Spinners ---------- */
	.spinner,
	.btn-spinner {
		width: 16px;
		height: 16px;
		border: 2px solid var(--surface-container-highest);
		border-top-color: var(--primary);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	.btn-spinner {
		width: 13px;
		height: 13px;
		border-color: rgb(255 255 255 / 0.4);
		border-top-color: #fff;
	}

	.btn-spinner.dark {
		border-color: var(--surface-container-highest);
		border-top-color: var(--primary);
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* ---------- Toast ---------- */
	.toast {
		position: fixed;
		right: var(--space-lg);
		top: 5rem;
		z-index: 50;
		display: flex;
		align-items: flex-start;
		gap: var(--space-sm);
		max-width: min(24rem, calc(100vw - 2rem));
		padding: var(--space-md);
		border-radius: var(--radius-lg);
		background: var(--surface-container-lowest);
		border: 1px solid var(--surface-container-high);
		box-shadow: var(--shadow-md);
		font-size: 13px;
	}

	.toast.ok .material-symbols-outlined {
		color: var(--secondary);
	}

	.toast.error {
		border-color: rgb(186 26 26 / 0.25);
	}

	.toast.error .material-symbols-outlined {
		color: var(--error);
	}

	@media (min-width: 64rem) {
		.stats {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}

	@media (max-width: 40rem) {
		.library {
			padding: var(--space-lg) var(--margin) 6rem;
		}

		.btn-upload {
			margin-left: 0;
			width: 100%;
			justify-content: center;
		}

		.toast {
			left: var(--margin);
			right: var(--margin);
		}
	}
</style>
