<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { processes } from '$lib/catalog/config';
	import { deletePart, listParts, type PartRecord } from '$lib/storage/parts';
	import { pendingUpload } from '$lib/upload.svelte';
	import { MODEL_ACCEPT as ACCEPT } from '$lib/viewer/formats';


	let parts = $state.raw<PartRecord[]>([]);
	let loading = $state(true);
	let loadError = $state('');
	let search = $state('');
	let filter = $state<string>('all');
	let confirmingDelete = $state<string | null>(null);
	let fileInput = $state<HTMLInputElement>();
	/** Object URLs for thumbnails, keyed by part id. */
	let thumbs = $state.raw<Record<string, string>>({});

	const processById = (id: string) => processes.find((p) => p.id === id);

	let counts = $derived(
		parts.reduce<Record<string, number>>((acc, p) => {
			acc[p.processId] = (acc[p.processId] ?? 0) + 1;
			return acc;
		}, {})
	);
	let filters = $derived(processes.filter((p) => counts[p.id]));

	let visible = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return parts.filter(
			(p) =>
				(filter === 'all' || p.processId === filter) &&
				(!q ||
					p.name.toLowerCase().includes(q) ||
					p.fileName.toLowerCase().includes(q) ||
					p.format.includes(q))
		);
	});

	async function refresh() {
		try {
			const next = await listParts();
			const urls: Record<string, string> = {};
			for (const part of next) {
				if (part.thumbnail) urls[part.id] = URL.createObjectURL(part.thumbnail);
			}
			revokeThumbs();
			thumbs = urls;
			parts = next;
			if (filter !== 'all' && !next.some((p) => p.processId === filter)) filter = 'all';
		} catch (err) {
			loadError = (err as Error).message || 'Could not read your shelf.';
		} finally {
			loading = false;
		}
	}

	function revokeThumbs() {
		for (const url of Object.values(thumbs)) URL.revokeObjectURL(url);
	}

	onMount(() => {
		refresh();
		// Pick up edits made in another tab when coming back to this one.
		const onVisible = () => document.visibilityState === 'visible' && refresh();
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			document.removeEventListener('visibilitychange', onVisible);
			revokeThumbs();
		};
	});

	function addFile(files: FileList | null | undefined) {
		const file = files?.[0];
		if (!file) return;
		pendingUpload.file = file;
		goto('/make/fdm');
	}

	async function remove(part: PartRecord) {
		if (confirmingDelete !== part.id) {
			confirmingDelete = part.id;
			return;
		}
		confirmingDelete = null;
		await deletePart(part.id);
		await refresh();
	}

	function editHref(part: PartRecord) {
		const process = processById(part.processId);
		const id = process && !process.comingSoon ? process.id : 'fdm';
		return `/make/${id}?part=${part.id}`;
	}

	function downloadManifest() {
		const header = [
			'Name',
			'File',
			'Format',
			'Process',
			'X (mm)',
			'Y (mm)',
			'Z (mm)',
			'Volume (cm3)',
			'Triangles',
			'Issues',
			'Specs',
			'Estimate ($/unit)',
			'Quoted ($/unit)',
			'Last edited'
		];
		const rows = visible.map((p) => {
			const s = p.summary;
			return [
				p.name,
				p.fileName,
				p.format.toUpperCase(),
				processById(p.processId)?.title ?? p.processId,
				s?.size.x.toFixed(2) ?? '',
				s?.size.y.toFixed(2) ?? '',
				s?.size.z.toFixed(2) ?? '',
				s?.volume.toFixed(2) ?? '',
				s?.triangles ?? '',
				s?.issues ?? '',
				s?.specs.map((c) => c.label).join('; ') ?? '',
				s?.estimateTotal.toFixed(2) ?? '',
				s?.quotedTotal?.toFixed(2) ?? '',
				new Date(p.updatedAt).toISOString()
			];
		});
		const csv = [header, ...rows]
			.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
			.join('\r\n');
		const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
		const a = Object.assign(document.createElement('a'), {
			href: url,
			download: `ad-forge-shelf-${new Date().toISOString().slice(0, 10)}.csv`
		});
		a.click();
		URL.revokeObjectURL(url);
	}

	function fileSize(bytes: number) {
		if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	}

	function dims(part: PartRecord) {
		const s = part.summary?.size;
		if (!s) return '';
		const f = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
		return `${f(s.x)} × ${f(s.y)} × ${f(s.z)} mm`;
	}

	function edited(ts: number) {
		const mins = Math.round((Date.now() - ts) / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins} min ago`;
		const hrs = Math.round(mins / 60);
		if (hrs < 24) return `${hrs} h ago`;
		return new Date(ts).toLocaleDateString();
	}
</script>

<svelte:head>
	<title>Shelf — AD-Forge</title>
</svelte:head>

<section class="shelf">
	<header class="intro">
		<h1>Shelf</h1>
		<p>
			Manage, configure, and prepare your CAD files across multiple fabrication processes. When
			ready, upload the models and order from the same place.
		</p>
	</header>

	<div class="toolbar">
		<label class="search">
			<span class="material-symbols-outlined">search</span>
			<input type="search" placeholder="Search part name or format…" bind:value={search} />
		</label>

		<div class="filters" role="group" aria-label="Filter by process">
			<button class:active={filter === 'all'} onclick={() => (filter = 'all')}>All ({parts.length})</button>
			{#each filters as p (p.id)}
				<button class:active={filter === p.id} onclick={() => (filter = p.id)}>{p.badge} ({counts[p.id]})</button>
			{/each}
		</div>

		<div class="toolbar-actions">
			<button class="btn-outline" onclick={downloadManifest} disabled={!visible.length}>
				<span class="material-symbols-outlined">file_download</span>Download Spec Manifest
			</button>
			<button class="btn-add" onclick={() => fileInput?.click()}>
				<span class="material-symbols-outlined">add_box</span>Add CAD File / Model
			</button>
			<input bind:this={fileInput} type="file" accept={ACCEPT} hidden onchange={(e) => addFile(e.currentTarget.files)} />
		</div>
	</div>

	{#if loading}
		<div class="state">
			<span class="spinner"></span>
			<p>Loading your shelf…</p>
		</div>
	{:else if loadError}
		<div class="state">
			<span class="material-symbols-outlined state-icon error">error</span>
			<h2>Couldn't open your shelf</h2>
			<p>{loadError}</p>
		</div>
	{:else if !parts.length}
		<div class="state">
			<span class="material-symbols-outlined state-icon">inventory_2</span>
			<h2>Your shelf is empty</h2>
			<p>Upload an STL, OBJ, 3MF or PLY file. Every model you configure is saved here in this browser so you can pick it up later.</p>
			<button class="btn-add" onclick={() => fileInput?.click()}>
				<span class="material-symbols-outlined">add_box</span>Add CAD File / Model
			</button>
		</div>
	{:else if !visible.length}
		<div class="state">
			<span class="material-symbols-outlined state-icon">folder_open</span>
			<h2>No parts match</h2>
			<p>Clear the search or process filter to see everything on your shelf.</p>
			<button class="btn-outline" onclick={() => ((search = ''), (filter = 'all'))}>Clear filters</button>
		</div>
	{:else}
		<ul class="list">
			{#each visible as part (part.id)}
				{@const process = processById(part.processId)}
				{@const s = part.summary}
				<li class="row">
					<a class="thumb" href={editHref(part)} aria-label={`Open ${part.name}`}>
						{#if thumbs[part.id]}
							<img src={thumbs[part.id]} alt="" loading="lazy" />
						{:else}
							<span class="material-symbols-outlined thumb-empty">deployed_code</span>
						{/if}
						<span class="badge process">{process?.badge ?? part.processId}</span>
						<span class="badge format">{part.format.toUpperCase()}</span>
					</a>

					<div class="ident">
						<a class="name" href={editHref(part)} title={part.fileName}>{part.name}</a>
						<span class="meta">
							{[fileSize(part.fileSize), dims(part), `edited ${edited(part.updatedAt)}`].filter(Boolean).join(' • ')}
						</span>
						{#if s}
							<span class="status" class:warn={s.issues > 0}>
								<span class="dot"></span>{s.issues ? `${s.issues} ${s.issues === 1 ? 'issue' : 'issues'} to review` : 'No errors'}
							</span>
						{/if}
					</div>

					<div class="specs">
						{#each s?.specs ?? [] as chip (chip.label)}
							<span class="chip"><span class="material-symbols-outlined">{chip.icon}</span>{chip.label}</span>
						{:else}
							<span class="chip muted">Not configured yet</span>
						{/each}
					</div>

					<div class="price">
						{#if s?.quotedTotal != null}
							<span class="amount">${s.quotedTotal.toFixed(2)}</span>
							<span class="per">/ unit · quoted</span>
						{:else if s}
							<span class="amount estimate">≈ ${s.estimateTotal.toFixed(2)}</span>
							<span class="per">/ unit · estimate</span>
						{/if}
					</div>

					<div class="actions">
						<button
							class="icon-btn"
							title={s?.quotedTotal != null ? 'Confirm & Upload' : 'Get an accurate quote in the configurator first'}
							aria-label="Confirm & Upload"
							disabled={s?.quotedTotal == null}
						>
							<span class="material-symbols-outlined">cloud_done</span>
						</button>
						<a class="icon-btn" href={editHref(part)} title="Edit Parameters" aria-label="Edit Parameters">
							<span class="material-symbols-outlined">tune</span>
						</a>
						<button
							class="icon-btn danger"
							class:confirm={confirmingDelete === part.id}
							title={confirmingDelete === part.id ? 'Click again to delete' : 'Delete Part'}
							aria-label="Delete Part"
							onclick={() => remove(part)}
							onblur={() => confirmingDelete === part.id && (confirmingDelete = null)}
						>
							<span class="material-symbols-outlined">{confirmingDelete === part.id ? 'delete_forever' : 'delete'}</span>
						</button>
					</div>
				</li>
			{/each}
		</ul>
		<p class="footnote">
			<span class="material-symbols-outlined">info</span>
			Parts are stored in this browser only. Clearing site data removes them.
		</p>
	{/if}
</section>

<style>
	.shelf {
		max-width: 90rem;
		margin: 0 auto;
		padding: var(--space-xl) var(--gutter-desktop) 4rem;
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
	}

	.intro h1 {
		font-size: 30px;
		line-height: 38px;
		font-weight: 700;
		letter-spacing: -0.02em;
	}

	.intro p {
		max-width: 42rem;
		margin-top: var(--space-xs);
		font-size: 15px;
		line-height: 22px;
		color: var(--on-surface-variant);
	}

	/* ---------- Toolbar ---------- */
	.toolbar {
		padding: var(--space-sm);
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-sm);
		background: var(--surface-container-lowest);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
	}

	.search {
		flex: 1 1 16rem;
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: 0 var(--space-sm);
		border-radius: var(--radius-md);
		background: var(--surface-container-low);
		border: 1px solid transparent;
	}

	.search:focus-within {
		border-color: var(--primary);
	}

	.search .material-symbols-outlined {
		font-size: 18px;
		color: var(--on-surface-variant);
	}

	.search input {
		flex: 1;
		min-width: 0;
		padding: 0.5rem 0;
		border: none;
		outline: none;
		background: none;
		font: inherit;
		color: var(--on-surface);
	}

	.filters {
		display: flex;
		flex-wrap: wrap;
		padding: 2px;
		border-radius: var(--radius-md);
		background: var(--surface-container);
	}

	.filters button {
		padding: 0.375rem var(--space-md);
		border-radius: var(--radius-md);
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 500;
		color: var(--on-surface-variant);
	}

	.filters button:hover {
		color: var(--on-surface);
	}

	.filters button.active {
		background: var(--surface-container-lowest);
		color: var(--primary);
		font-weight: 600;
		box-shadow: var(--shadow-sm);
	}

	.toolbar-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		margin-left: auto;
	}

	.btn-outline,
	.btn-add {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.45rem var(--space-md);
		border-radius: var(--radius-md);
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		transition: background-color 0.15s ease;
	}

	.btn-outline {
		background: var(--surface-container);
		color: var(--on-surface);
	}

	.btn-outline:hover:not(:disabled) {
		background: var(--surface-container-high);
	}

	.btn-outline:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-add {
		background: var(--primary);
		color: var(--on-primary);
		box-shadow: var(--shadow-sm);
	}

	.btn-add:hover {
		background: var(--primary-container);
	}

	.btn-outline .material-symbols-outlined,
	.btn-add .material-symbols-outlined {
		font-size: 16px;
	}

	/* ---------- Rows ---------- */
	.list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}

	.row {
		padding: var(--space-md);
		display: grid;
		grid-template-columns: 7.5rem 1fr;
		gap: var(--space-md);
		align-items: center;
		background: var(--surface-container-lowest);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
	}

	.thumb {
		position: relative;
		grid-row: span 2;
		width: 7.5rem;
		aspect-ratio: 1;
		border-radius: var(--radius-md);
		overflow: hidden;
		background: linear-gradient(160deg, var(--surface-container-lowest), var(--surface-container));
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		padding: 0.5rem;
		filter: drop-shadow(0 6px 8px rgb(0 0 0 / 0.15));
	}

	.thumb-empty {
		font-size: 40px;
		color: var(--outline-variant);
	}

	.badge {
		position: absolute;
		padding: 1px 0.375rem;
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-size: 9px;
		line-height: 14px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.badge.process {
		top: 0.375rem;
		left: 0.375rem;
		background: var(--primary);
		color: var(--on-primary);
	}

	.badge.format {
		right: 0.375rem;
		bottom: 0.375rem;
		background: rgb(255 255 255 / 0.85);
		color: var(--on-surface-variant);
	}

	.ident {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.name {
		font-size: 17px;
		line-height: 24px;
		font-weight: 600;
		letter-spacing: -0.01em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.name:hover {
		color: var(--primary);
	}

	.meta {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--on-surface-variant);
	}

	.status {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--secondary);
	}

	.status .dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: currentColor;
	}

	.status.warn {
		color: var(--tertiary);
	}

	.specs {
		grid-column: 2;
		padding: var(--space-sm);
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		border-radius: var(--radius-md);
		background: var(--surface-container-low);
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.125rem 0.375rem;
		border-radius: var(--radius-sm);
		background: var(--surface-container-lowest);
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 16px;
		color: var(--on-surface);
	}

	.chip .material-symbols-outlined {
		font-size: 14px;
		color: var(--on-surface-variant);
	}

	.chip.muted {
		color: var(--on-surface-variant);
	}

	.price {
		grid-column: 2;
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
	}

	.amount {
		font-family: var(--font-mono);
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--on-surface);
	}

	.amount.estimate {
		color: var(--on-surface-variant);
	}

	.per {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--on-surface-variant);
	}

	.actions {
		grid-column: 2;
		display: flex;
		gap: var(--space-xs);
	}

	.icon-btn {
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius-md);
		background: var(--surface-container);
		color: var(--on-surface);
		display: flex;
		align-items: center;
		justify-content: center;
		transition:
			background-color 0.15s ease,
			color 0.15s ease;
	}

	.icon-btn:hover:not(:disabled) {
		background: var(--surface-container-high);
	}

	.icon-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.icon-btn.danger:hover,
	.icon-btn.confirm {
		background: var(--error-container);
		color: var(--error);
	}

	.icon-btn .material-symbols-outlined {
		font-size: 20px;
	}

	.footnote {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 12px;
		color: var(--on-surface-variant);
	}

	.footnote .material-symbols-outlined {
		font-size: 16px;
		color: var(--secondary);
	}

	/* ---------- Empty / loading ---------- */
	.state {
		padding: 4rem var(--space-lg);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-sm);
		text-align: center;
		background: var(--surface-container-lowest);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
	}

	.state h2 {
		font-size: 18px;
		font-weight: 600;
	}

	.state p {
		max-width: 30rem;
		color: var(--on-surface-variant);
	}

	.state-icon {
		font-size: 40px;
		color: var(--outline-variant);
	}

	.state-icon.error {
		color: var(--error);
	}

	.spinner {
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 50%;
		border: 3px solid var(--surface-container-highest);
		border-top-color: var(--primary);
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (min-width: 1024px) {
		.row {
			grid-template-columns: 7.5rem minmax(12rem, 18rem) 1fr auto auto;
		}

		.thumb {
			grid-row: auto;
		}

		.specs,
		.price,
		.actions {
			grid-column: auto;
		}

		.price {
			flex-direction: column;
			align-items: flex-end;
			gap: 0;
			min-width: 8rem;
		}
	}
</style>
