<script lang="ts">
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import MoleculeArt from '$lib/components/MoleculeArt.svelte';
	import { money, nozzleRange, ratingRows, uses, type FilamentSummary, type Ratings, type UseId } from '$lib/catalog/library';

	let { data } = $props();
	let library = $derived(data.library);

	type ProcessTab = 'fdm' | 'resin' | 'cnc' | 'laser';
	const tabIds: ProcessTab[] = ['fdm', 'resin', 'cnc', 'laser'];

	let tab = $state<ProcessTab>(initial('process', tabIds, 'fdm'));
	let use = $state<UseId | 'all'>(initial('use', uses.map((u) => u.id), 'all'));

	function initial<T extends string>(param: string, allowed: T[], fallback: T): T {
		const value = page.url.searchParams.get(param) as T | null;
		return value && allowed.includes(value) ? value : fallback;
	}

	/** Keep the tab and filter in the URL so a view can be linked to. */
	function remember(next: { process?: ProcessTab; use?: UseId | 'all' }) {
		if (next.process) tab = next.process;
		if (next.use) use = next.use;
		const url = new URL(page.url);
		const set = (k: string, v: string, dflt: string) => (v === dflt ? url.searchParams.delete(k) : url.searchParams.set(k, v));
		set('process', tab, 'fdm');
		set('use', use, 'all');
		replaceState(url, page.state);
	}

	let tabs = $derived([
		{ id: 'fdm' as const, label: 'FDM filament', count: String(library.filaments.length) },
		{ id: 'resin' as const, label: 'Resin (SLA)', count: String(library.resins.length) },
		{ id: 'cnc' as const, label: 'CNC stock', count: String(library.cnc.length) },
		{ id: 'laser' as const, label: 'Laser', count: 'soon' }
	]);

	let byHandle = $derived(new Map(library.filaments.map((f) => [f.handle, f])));
	let groups = $derived(
		library.tiers
			.map((t) => ({ ...t, items: t.materials.map((h) => byHandle.get(h)!).filter((m) => use === 'all' || m.uses.includes(use)) }))
			.filter((g) => g.items.length > 0)
	);
	let hint = $derived(uses.find((u) => u.id === use)?.hint);

	function segments(value: number) {
		return [1, 2, 3, 4, 5].map((k) => k <= value);
	}

	const priceLabel = (m: FilamentSummary) => (m.priceVaries ? 'from ' : '');

	// ---------- Compare table sorting ----------

	type SortKey = 'name' | keyof Ratings | 'nozzle' | 'price';
	type Column = { key: SortKey; label: string; numeric?: boolean };

	const columns: Column[] = [
		{ key: 'name', label: 'Material' },
		...ratingRows.map((r) => ({ key: r.key, label: r.short })),
		{ key: 'nozzle', label: 'Nozzle' },
		{ key: 'price', label: 'Price /g', numeric: true }
	];

	/** Null keeps the library order (tier by tier). */
	let sort = $state<{ key: SortKey; dir: 1 | -1 } | null>(null);

	/** Ratings sort best-first on the first click; names, nozzles and prices smallest-first. */
	function toggleSort(key: SortKey) {
		const firstDir = key in ({ strength: 1, heat: 1, flexibility: 1, finish: 1 } as const) ? -1 : 1;
		if (sort?.key !== key) sort = { key, dir: firstDir };
		else if (sort.dir === firstDir) sort = { key, dir: -firstDir as 1 | -1 };
		else sort = null;
	}

	function sortValue(m: FilamentSummary, key: SortKey): number | string {
		switch (key) {
			case 'name':
				return m.name.toLowerCase();
			case 'price':
				return m.pricePerGram;
			case 'nozzle':
				// "Any" first, then by the smallest approved size, then the largest.
				return m.nozzles?.length ? Math.min(...m.nozzles) * 100 + Math.max(...m.nozzles) : 0;
			default:
				return m.ratings?.[key] ?? 0;
		}
	}

	let tableRows = $derived.by(() => {
		const s = sort;
		if (!s) return library.filaments;
		return library.filaments
			.map((m, i) => ({ m, i }))
			.sort((a, b) => {
				const va = sortValue(a.m, s.key), vb = sortValue(b.m, s.key);
				const cmp = typeof va === 'string' ? va.localeCompare(vb as string) : va - (vb as number);
				// Ties keep the library order, whichever way the column runs.
				return cmp * s.dir || a.i - b.i;
			})
			.map((e) => e.m);
	});

	function ariaSort(key: SortKey) {
		return sort?.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none';
	}
</script>

<svelte:head>
	<title>Materials Library — AD-Forge</title>
	<meta name="description" content="Every material AD-Forge can make your part from: what each is good at, what it costs, and which colours are on the shelf." />
</svelte:head>

<section class="hero" id="top">
	<div class="wrap hero-inner">
		<div class="hero-row">
			<div class="hero-copy">
				<span class="eyebrow">MATERIALS LIBRARY</span>
				<h1>Pick the right material <span class="accent">for the job.</span></h1>
				<p class="lead">
					Everything we can make your part from: what each material is good at, what it costs, and which colours are on the shelf. Not
					sure? Tell us what the part needs to do.
				</p>
			</div>
			<aside class="pricing-note">
				<span class="mono-label">HOW PRICING WORKS</span>
				<p>
					FDM is priced <strong>per gram</strong> of material used plus a fixed machine rate. Upload a file on the Workbench and Forge
					weighs it for you, no guessing.
				</p>
				<a class="text-link" href="/make/fdm">Get an instant quote →</a>
			</aside>
		</div>

		<div class="tabs" role="tablist" aria-label="Process">
			{#each tabs as t (t.id)}
				<button
					class="tab"
					class:on={tab === t.id}
					role="tab"
					id={`tab-${t.id}`}
					aria-selected={tab === t.id}
					aria-controls="process-panel"
					onclick={() => remember({ process: t.id })}
				>
					{t.label} <span class="count">{t.count}</span>
				</button>
			{/each}
		</div>
	</div>
</section>

<div class="wrap content" id="process-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
	{#if tab === 'fdm'}
		<div class="filter">
			<span class="mono-label">WHAT DOES YOUR PART NEED TO DO?</span>
			<div class="chips">
				<button class="chip" class:on={use === 'all'} aria-pressed={use === 'all'} onclick={() => remember({ use: 'all' })}>Show all</button>
				{#each uses as u (u.id)}
					<button class="chip" class:on={use === u.id} aria-pressed={use === u.id} onclick={() => remember({ use: u.id })}>{u.label}</button>
				{/each}
			</div>
			{#if hint}
				<p class="hint">{hint}</p>
			{/if}
		</div>

		{#each groups as g (g.handle)}
			<section class="tier" aria-labelledby={`tier-${g.handle}`}>
				<div class="tier-head">
					<h2 id={`tier-${g.handle}`}>{g.name}</h2>
					<span>{g.blurb}</span>
				</div>
				<div class="grid">
					{#each g.items as m (m.handle)}
						<a class="card" href={`/materials/${m.handle}`}>
							<div class="card-art">
								<div class="art-mol"><MoleculeArt name={m.molecule} /></div>
								<div class="art-foot">
									<span class="dots" aria-label={`${m.colorCount} ${m.colorCount === 1 ? 'colour' : 'colours'}`}>
										{#each m.swatches as hex, i (i)}
											<span class="dot" style:background={hex}></span>
										{/each}
										{#if m.colorCount > m.swatches.length}
											<span class="dot more">+{m.colorCount - m.swatches.length}</span>
										{/if}
									</span>
									{#if m.polymer}<span class="polymer">{m.polymer}</span>{/if}
								</div>
							</div>
							<div class="card-body">
								<div class="card-title">
									<h3>{m.name}</h3>
									<p>{m.blurb}</p>
								</div>
								{#if m.ratings}
									<div class="bars">
										{#each ratingRows as row (row.key)}
											<div class="bar">
												<span class="bar-label">{row.short}</span>
												<span class="segs" role="img" aria-label={`${row.label}: ${m.ratings[row.key]} of 5`}>
													{#each segments(m.ratings[row.key]) as on, i (i)}<span class="seg" class:on></span>{/each}
												</span>
											</div>
										{/each}
									</div>
								{/if}
								{#if m.tags.length}
									<div class="tags">
										{#each m.tags as tag (tag.label)}<span class="tag {tag.tone}">{tag.label}</span>{/each}
									</div>
								{/if}
								<div class="card-foot">
									<span><span class="muted">{priceLabel(m)}</span><span class="price">{money(m.pricePerGram)}</span><span class="muted"> /g</span></span>
									<span class="details">Details →</span>
								</div>
							</div>
						</a>
					{/each}
				</div>
			</section>
		{/each}

		<section class="compare">
			<div>
				<span class="eyebrow">AT A GLANCE</span>
				<h2>Compare every filament</h2>
			</div>
			<div class="table-scroll">
				<table>
					<thead>
						<tr>
							{#each columns as col (col.key)}
								<th scope="col" class:num={col.numeric} aria-sort={ariaSort(col.key)}>
									<button class="sort" class:active={sort?.key === col.key} onclick={() => toggleSort(col.key)}>
										{col.label}
										<span class="sort-icon material-symbols-outlined" aria-hidden="true">
											{sort?.key === col.key ? (sort.dir === 1 ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}
										</span>
									</button>
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each tableRows as m (m.handle)}
							<tr>
								<th scope="row"><a href={`/materials/${m.handle}`}>{m.name}</a></th>
								{#each ratingRows as row (row.key)}
									<td>
										{#if m.ratings}
											<span class="pips" role="img" aria-label={`${m.ratings[row.key]} of 5`}>
												{#each segments(m.ratings[row.key]) as on, i (i)}<span class="pip" class:on></span>{/each}
											</span>
										{:else}—{/if}
									</td>
								{/each}
								<td class="mono">{nozzleRange(m.nozzles)}</td>
								<td class="mono num strong">{priceLabel(m)}{money(m.pricePerGram)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{:else if tab === 'resin' || tab === 'cnc'}
		{#if tab === 'cnc'}
			<p class="intro">CNC is priced as raw stock plus machine time. Stock below is what we keep on hand; anything else can be ordered in.</p>
		{/if}
		<div class="grid wide">
			{#each tab === 'resin' ? library.resins : library.cnc as m (m.id)}
				<a class="card" href={m.href}>
					{#if m.image}
						<img class="card-photo" src={m.image.src} srcset={m.image.srcset} sizes="(min-width: 1280px) 400px, (min-width: 640px) 50vw, 100vw" alt="" loading="lazy" />
					{:else}
						<div class="card-photo" style:background={m.swatches[0] ?? 'var(--surface-container)'}></div>
					{/if}
					<div class="card-body">
						<div class="card-title">
							<h3>{m.name}</h3>
							<p>{m.blurb}</p>
						</div>
						{#if m.swatches.length > 1}
							<span class="dots flat">
								{#each m.swatches as hex, i (i)}<span class="dot" style:background={hex}></span>{/each}
							</span>
						{/if}
						{#if m.stock}<span class="mono small muted">{m.stock}</span>{/if}
						<div class="card-foot">
							<span class="price">{m.price ?? ''}</span>
							<span class="details">Start a part →</span>
						</div>
					</div>
				</a>
			{:else}
				<p class="intro">Nothing listed here right now.</p>
			{/each}
		</div>
	{:else}
		<div class="soon">
			<span class="tag teal">COMING SOON</span>
			<h2>Laser cutting &amp; engraving materials</h2>
			<p>Acrylic, plywood and engraving stock will show up here once the laser service opens.</p>
		</div>
	{/if}

	<section class="help">
		<div>
			<h2>Still not sure which one?</h2>
			<p>Upload your file and leave a note about where the part will live. We'll suggest a material before we print.</p>
		</div>
		<div class="help-actions">
			<a class="help-primary" href="/make/fdm">Upload a file</a>
		</div>
	</section>
</div>

<style>
	.wrap {
		max-width: 1280px;
		margin: 0 auto;
		padding-left: var(--gutter-desktop);
		padding-right: var(--gutter-desktop);
	}

	.hero {
		background: var(--surface-container-lowest);
		border-bottom: 1px solid var(--surface-container);
	}

	.hero-inner {
		padding-top: 56px;
		display: flex;
		flex-direction: column;
		gap: 32px;
	}

	.hero-row {
		display: flex;
		flex-wrap: wrap;
		gap: 40px;
		align-items: flex-end;
		justify-content: space-between;
	}

	.hero-copy {
		flex: 1 1 520px;
		max-width: 680px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	h1 {
		font-size: 44px;
		line-height: 1.1;
		font-weight: 700;
		letter-spacing: -0.5px;
	}

	.accent {
		color: var(--primary);
	}

	.lead {
		font-size: 16px;
		line-height: 1.6;
		color: var(--on-surface-variant);
	}

	.pricing-note {
		flex: 0 1 380px;
		background: var(--surface-container-low);
		border: 1px solid var(--surface-container);
		border-radius: var(--radius-lg);
		padding: 20px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.pricing-note p {
		font-size: 14px;
		line-height: 1.55;
	}

	.mono-label {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.6px;
		color: var(--on-surface-variant);
	}

	.text-link {
		color: var(--primary);
		font-weight: 600;
	}

	.text-link:hover {
		color: #7a2b00;
	}

	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 28px;
	}

	.tab {
		font-weight: 600;
		font-size: 14px;
		min-height: 48px;
		padding: 0 4px;
		border-bottom: 2px solid transparent;
		color: var(--on-surface-variant);
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.tab.on {
		color: var(--primary);
		border-bottom-color: var(--primary);
	}

	.count {
		font: 500 11px var(--font-mono);
		background: var(--surface-container);
		color: var(--on-surface-variant);
		padding: 2px 6px;
		border-radius: var(--radius-md);
	}

	.content {
		padding-top: 32px;
		padding-bottom: 80px;
		display: flex;
		flex-direction: column;
		gap: 40px;
	}

	.filter {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.chip {
		font-size: 13px;
		font-weight: 500;
		min-height: 44px;
		padding: 0 16px;
		border-radius: 999px;
		border: 1px solid var(--surface-container-highest);
		background: var(--surface-container-lowest);
		color: var(--on-surface);
	}

	.chip:hover {
		border-color: var(--outline-variant);
	}

	.chip.on {
		background: var(--on-surface);
		border-color: var(--on-surface);
		color: #fff;
	}

	.hint {
		font-size: 14px;
		color: #00564f;
		background: rgb(0 106 97 / 0.08);
		border-radius: 6px;
		padding: 10px 14px;
	}

	.tier {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.tier-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 12px;
		border-bottom: 1px solid var(--surface-container);
		padding-bottom: 10px;
	}

	.tier-head h2 {
		font-size: 20px;
		line-height: 28px;
		font-weight: 600;
	}

	.tier-head span {
		font-size: 14px;
		color: var(--on-surface-variant);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 16px;
	}

	.grid.wide {
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
	}

	.card {
		background: var(--surface-container-lowest);
		border: 1px solid var(--surface-container);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease;
		--molecule-bg: var(--surface-container-low);
	}

	.card:hover {
		border-color: var(--outline-variant);
		box-shadow: var(--shadow-md);
		--molecule-stroke: var(--primary);
	}

	.card-art {
		height: 132px;
		box-sizing: border-box;
		padding: 14px 16px 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		background-color: var(--surface-container-low);
		background-image: radial-gradient(rgb(19 27 46 / 0.07) 1px, transparent 1px);
		background-size: 12px 12px;
	}

	.art-mol {
		flex: 1;
		min-height: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.art-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding-left: 6px;
	}

	.polymer {
		font: 10px/1.3 var(--font-mono);
		letter-spacing: 0.4px;
		color: var(--on-surface-variant);
		text-align: right;
	}

	.dots {
		display: flex;
		align-items: center;
		flex: none;
	}

	.dot {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 2px solid #fff;
		box-shadow: 0 0 0 1px rgb(19 27 46 / 0.12);
		margin-left: -6px;
	}

	.dots.flat .dot {
		margin-left: 0;
		margin-right: 4px;
	}

	.dot.more {
		box-sizing: border-box;
		width: auto;
		min-width: 26px;
		height: 26px;
		padding: 0 6px;
		border-radius: 13px;
		background: #fff;
		color: var(--on-surface);
		font: 600 10px/1 var(--font-mono);
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.card-photo {
		display: block;
		width: 100%;
		aspect-ratio: 16 / 9;
		object-fit: cover;
		background: var(--surface-container-low);
	}

	.card-body {
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		flex: 1;
	}

	.card-title {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.card-title h3 {
		font-size: 17px;
		line-height: 24px;
		font-weight: 600;
	}

	.card-title p {
		font-size: 13px;
		line-height: 1.5;
		color: var(--on-surface-variant);
	}

	.bars {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.bar {
		display: grid;
		grid-template-columns: 72px 1fr;
		align-items: center;
		gap: 10px;
	}

	.bar-label {
		font: 500 11px var(--font-mono);
		color: var(--on-surface-variant);
		text-transform: uppercase;
		letter-spacing: 0.6px;
	}

	.segs {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 3px;
	}

	.seg {
		height: 6px;
		border-radius: 2px;
		background: var(--surface-container);
	}

	.seg.on,
	.pip.on {
		background: var(--primary);
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.tag {
		font: 500 11px var(--font-mono);
		text-transform: uppercase;
		padding: 3px 7px;
		border-radius: var(--radius-md);
		background: var(--surface-container-low);
		color: var(--on-surface-variant);
	}

	.tag.warn {
		background: #fff4d6;
		color: #7a4a00;
	}

	.tag.teal {
		background: var(--secondary-tint);
		color: #00564f;
	}

	.card-foot {
		margin-top: auto;
		padding-top: 12px;
		border-top: 1px solid var(--surface-container-low);
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.muted {
		font-size: 12px;
		color: var(--on-surface-variant);
	}

	.price {
		font: 600 16px var(--font-mono);
	}

	.details {
		font-size: 13px;
		font-weight: 600;
		color: var(--primary);
	}

	.compare {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.compare h2 {
		margin-top: 6px;
		font-size: 24px;
		line-height: 32px;
		font-weight: 700;
	}

	.table-scroll {
		overflow-x: auto;
		background: var(--surface-container-lowest);
		border: 1px solid var(--surface-container);
		border-radius: var(--radius-lg);
	}

	table {
		border-collapse: collapse;
		width: 100%;
		min-width: 820px;
	}

	thead th {
		font: 600 11px var(--font-mono);
		text-transform: uppercase;
		letter-spacing: 0.6px;
		color: var(--on-surface-variant);
		text-align: left;
		padding: 0;
		border-bottom: 1px solid var(--surface-container);
		white-space: nowrap;
	}

	.sort {
		width: 100%;
		min-height: 44px;
		padding: 0 16px;
		display: flex;
		align-items: center;
		gap: 4px;
		font: inherit;
		letter-spacing: inherit;
		text-transform: inherit;
		color: inherit;
	}

	thead th.num .sort {
		justify-content: flex-end;
	}

	.sort:hover,
	.sort.active {
		color: var(--on-surface);
	}

	.sort:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: -2px;
	}

	.sort-icon {
		font-size: 14px;
		opacity: 0.5;
	}

	.sort.active .sort-icon {
		opacity: 1;
		color: var(--primary);
	}

	tbody th,
	td {
		padding: 12px 16px;
		border-bottom: 1px solid var(--surface-container-low);
		font-size: 14px;
		white-space: nowrap;
		text-align: left;
	}

	tbody th {
		font-weight: 600;
	}

	tbody th a:hover {
		color: var(--primary);
	}

	tbody tr:last-child > * {
		border-bottom: 0;
	}

	.num {
		text-align: right;
	}

	.mono {
		font-family: var(--font-mono);
		font-size: 12px;
	}

	td.mono:not(.strong) {
		color: var(--on-surface-variant);
	}

	.strong {
		font-size: 14px;
		font-weight: 600;
	}

	.small {
		font-size: 12px;
	}

	.pips {
		display: inline-flex;
		gap: 2px;
	}

	.pip {
		width: 8px;
		height: 8px;
		border-radius: 2px;
		background: var(--surface-container);
	}

	.intro {
		font-size: 14px;
		color: var(--on-surface-variant);
		max-width: 680px;
	}

	.soon {
		background: var(--surface-container-lowest);
		border: 1px dashed var(--outline-variant);
		border-radius: var(--radius-lg);
		padding: 48px 24px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		text-align: center;
	}

	.soon h2 {
		font-size: 22px;
		line-height: 28px;
	}

	.soon p {
		font-size: 14px;
		color: var(--on-surface-variant);
		max-width: 480px;
	}

	.help {
		background: var(--on-surface);
		color: #fff;
		border-radius: var(--radius-lg);
		padding: 32px;
		display: flex;
		flex-wrap: wrap;
		gap: 24px;
		align-items: center;
		justify-content: space-between;
	}

	.help > div:first-child {
		flex: 1 1 420px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.help h2 {
		font-size: 22px;
		line-height: 28px;
		font-weight: 700;
	}

	.help p {
		font-size: 15px;
		line-height: 1.5;
		color: #c9cfe6;
	}

	.help-primary {
		display: inline-block;
		background: var(--primary-container);
		color: #fff;
		font-weight: 600;
		padding: 14px 20px;
		border-radius: var(--radius-md);
	}

	.help-primary:hover {
		background: var(--primary);
	}

	@media (max-width: 640px) {
		h1 {
			font-size: 34px;
		}

		.hero-inner {
			padding-top: 32px;
		}

		.help {
			padding: 24px;
		}
	}
</style>
