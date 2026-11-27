<script lang="ts">
	import { nozzles } from '$lib/catalog/config';
	import { money, nozzleRange, ratingRows, type LibraryColor, type LibraryImage } from '$lib/catalog/library';
	import { discontinuedNote, leadTime } from '$lib/catalog/stock';

	let { data } = $props();
	let m = $derived(data.material);

	let colors = $derived(m.groups.flatMap((g) => g.colors));
	let pickedId = $state<string | null>(null);
	let picked = $derived(colors.find((c) => c.id === pickedId) ?? colors.find((c) => c.inStock) ?? colors[0]);
	let pickedGroup = $derived(m.groups.find((g) => g.colors.includes(picked)));

	/** A print example the visitor clicked; picking a colour goes back to that colour's photo. */
	let shownImage = $state<LibraryImage | null>(null);
	let hero = $derived(shownImage ?? picked.image ?? m.cover);

	function pick(c: LibraryColor) {
		pickedId = c.id;
		shownImage = null;
	}

	// A different material (client-side navigation between detail pages) starts fresh.
	$effect.pre(() => {
		void m.handle;
		pickedId = null;
		shownImage = null;
	});

	function stock(c: LibraryColor) {
		if (c.inStock) return c.discontinued ? 'Last spools' : 'On the shelf';
		return leadTime(c).badge;
	}

	/** Every quality's layer height across the nozzles this filament prints with. */
	let layerHeights = $derived.by(() => {
		const allowed = nozzles.filter((n) => !m.nozzles || m.nozzles.includes(n.size));
		const h = (allowed.length ? allowed : nozzles).flatMap((n) => Object.values(n.layers));
		return `${Math.min(...h)}–${Math.max(...h)} mm`;
	});

	let techRows = $derived(
		[
			['Heat deflection temp. (0.45 MPa)', m.tech.heatDeflection, '°C'],
			['Tensile strength', m.tech.tensileStrength, 'MPa'],
			['Elongation at break', m.tech.elongation, '%'],
			['Bending modulus', m.tech.bendingModulus, 'MPa'],
			['Density', m.tech.density, 'g/cm³']
		]
			.filter((r): r is [string, number, string] => r[1] !== undefined)
			.map(([label, value, unit]) => ({ label, value: `${value.toLocaleString('en-CA')} ${unit}` }))
	);

	let makeHref = $derived(`/make/fdm?material=${encodeURIComponent(m.handle)}&color=${encodeURIComponent(picked.id)}`);
	let tierName = $derived(data.tiers[0]?.name);

	function segments(value: number) {
		return [1, 2, 3, 4, 5].map((k) => k <= value);
	}
</script>

<svelte:head>
	<title>{m.name} — Materials Library — AD-Forge</title>
	<meta name="description" content={m.blurb} />
	{#if m.cover}<meta property="og:image" content={m.cover.src} />{/if}
</svelte:head>

<div class="wrap page">
	<nav aria-label="Breadcrumb" class="crumbs">
		<a href="/materials">Materials</a><span aria-hidden="true">/</span><a href="/materials">FDM filament</a><span aria-hidden="true">/</span
		><span aria-current="page">{m.name}</span>
	</nav>

	<section class="hero">
		<div class="gallery">
			<div class="hero-photo" class:example={!!shownImage} style:background={shownImage ? null : picked.hex}>
				{#if hero}
					<img
						src={hero.src}
						srcset={hero.srcset}
						sizes="(min-width: 1280px) 680px, (min-width: 960px) 55vw, 100vw"
						alt={hero.alt}
						width={hero.width}
						height={hero.height}
					/>
				{/if}
			</div>
			{#if m.examples.length}
				<div class="examples">
					<span class="examples-label">Printed in {m.name}</span>
					<div class="thumbs">
						{#each m.examples as img, i (img.src)}
							<button
								class="thumb"
								class:on={shownImage?.src === img.src}
								style:aspect-ratio={img.width && img.height ? `${img.width} / ${img.height}` : null}
								aria-label={`Print example ${i + 1} of ${m.examples.length}`}
								aria-pressed={shownImage?.src === img.src}
								onclick={() => (shownImage = img)}
							>
								<img src={img.src} srcset={img.srcset} sizes="240px" alt="" loading="lazy" />
							</button>
						{/each}
					</div>
				</div>
			{/if}
		</div>

		<div class="summary">
			<div class="intro">
				<span class="eyebrow">FDM{tierName ? ` · ${tierName}` : ''}</span>
				<h1>{m.name}</h1>
				{#if m.descriptionHtml.trim()}
					<div class="description">{@html m.descriptionHtml}</div>
				{:else}
					<p class="description">{m.blurb}</p>
				{/if}
			</div>
			<div class="tags">
				<span class="tag">Nozzles {nozzleRange(picked.nozzles ?? m.nozzles)}</span>
				{#if !m.requiresEnclosure}<span class="tag teal">Large-scale available</span>{/if}
				{#each m.tags as tag (tag.label)}<span class="tag {tag.tone}">{tag.label}</span>{/each}
				<span class="tag">Prints in 2–3 days</span>
			</div>

			<div class="panel buy">
				<div class="cost">
					<span class="muted">Material cost</span>
					<span><span class="big-price">{money(picked.price)}</span><span class="muted"> / gram</span></span>
				</div>
				<p class="small muted">Your exact quote comes from the Workbench once you upload.</p>
				<div class="picker">
					<span class="picked">
						{pickedGroup?.name ? `${pickedGroup.name} · ` : ''}<span class="regular">{picked.name}</span> ·
						<span class="stock" class:ok={picked.inStock}>{stock(picked)}</span>
					</span>
					{#each m.groups as g (g.name)}
						<div class="swatch-row">
							{#if g.name || m.groups.length > 1}
								<span class="group-label">{g.name ?? 'Colours'} · {g.colors.length}</span>
							{/if}
							<div class="swatches" role="radiogroup" aria-label={g.name ?? 'Colour'}>
								{#each g.colors as c (c.id)}
									<button
										class="swatch"
										class:on={c.id === picked.id}
										role="radio"
										aria-checked={c.id === picked.id}
										aria-label={`${g.name ? `${g.name} ` : ''}${c.name}, ${stock(c)}`}
										title={c.name}
										onclick={() => pick(c)}
									>
										<span class="chip" style:background={c.hex}></span>
									</button>
								{/each}
							</div>
						</div>
					{/each}
				</div>
				{#if !picked.inStock}<p class="lead-note small" role="status">{leadTime(picked).note}</p>
				{:else if picked.discontinued}<p class="lead-note small" role="status">{discontinuedNote}</p>{/if}
				<a class="make" href={makeHref}>Make with {m.name} →</a>
			</div>
		</div>
	</section>

	{#if m.ratings || m.greatFor.length || m.avoidFor.length}
		<section class="split">
			{#if m.ratings}
				<div class="panel perf">
					<h2>How it performs</h2>
					{#each ratingRows as row (row.key)}
						<div class="bar">
							<span class="bar-label">{row.label}</span>
							<span class="segs" role="img" aria-label={`${m.ratings[row.key]} of 5`}>
								{#each segments(m.ratings[row.key]) as on, i (i)}<span class="seg" class:on></span>{/each}
							</span>
							<span class="bar-word">{row.words[m.ratings[row.key] - 1]}</span>
						</div>
					{/each}
					<p class="small muted">Ratings are relative to the other filaments we stock, not lab numbers.</p>
				</div>
			{/if}
			{#if m.greatFor.length || m.avoidFor.length}
				<div class="fit">
					{#if m.greatFor.length}
						<div class="panel fit-card good">
							<h2>Great for</h2>
							<ul>
								{#each m.greatFor as item (item)}<li><span class="mark" aria-hidden="true">✓</span>{item}</li>{/each}
							</ul>
						</div>
					{/if}
					{#if m.avoidFor.length}
						<div class="panel fit-card avoid">
							<h2>Pick something else for</h2>
							<ul>
								{#each m.avoidFor as item (item)}<li><span class="mark" aria-hidden="true">✕</span>{item}</li>{/each}
							</ul>
						</div>
					{/if}
				</div>
			{/if}
		</section>
	{/if}

	<section class="panel colours">
		<div class="colours-head">
			<h2>Colours</h2>
			<span class="small muted">Out-of-stock colours can still be ordered: we order the spool in and show when it arrives.</span>
		</div>
		{#each m.groups as g (g.name)}
			{@const groupNozzles = [...new Set(g.colors.flatMap((c) => c.nozzles ?? []))]}
			<div class="colour-group">
				<div class="colour-group-head">
					{#if g.name}<h3>{g.name}</h3>{/if}
					<span class="tag">{g.colors.length} {g.colors.length === 1 ? 'colour' : 'colours'}</span>
					{#if groupNozzles.length}<span class="tag">Nozzles {nozzleRange(groupNozzles)}</span>{/if}
				</div>
				<div class="colour-grid">
					{#each g.colors as c (c.id)}
						<button class="colour" class:on={c.id === picked.id} aria-pressed={c.id === picked.id} onclick={() => pick(c)}>
							<span class="chip" style:background={c.hex}></span>
							<span class="colour-text">
								<span>{c.name}</span>
								<span class="stock" class:ok={c.inStock}>{stock(c)}</span>
							</span>
						</button>
					{/each}
				</div>
			</div>
		{/each}
	</section>

	{#if techRows.length || m.tech.datasheets.length || m.designTips.length}
		<section class="split">
			<div class="panel tech">
				<h2>Technical data</h2>
				<dl>
					{#each techRows as row (row.label)}
						<div class="spec"><dt>{row.label}</dt><dd>{row.value}</dd></div>
					{/each}
					<div class="spec"><dt>Layer heights offered</dt><dd>{layerHeights}</dd></div>
				</dl>
				{#each m.tech.datasheets as url, i (url)}
					<a class="sheet" href={url} target="_blank" rel="noopener">
						{m.tech.datasheets.length > 1 ? `Datasheet ${i + 1}` : 'Datasheet'} (PDF) →
					</a>
				{/each}
			</div>
			{#if m.designTips.length}
				<div class="panel tips">
					<h2>Designing for {m.name}</h2>
					<ol>
						{#each m.designTips as tip, i (tip)}
							<li><span class="tip-no">{String(i + 1).padStart(2, '0')}</span><span>{tip}</span></li>
						{/each}
					</ol>
				</div>
			{/if}
		</section>
	{/if}

	{#if data.compare.length}
		<section class="related">
			<h2>Compare with</h2>
			<div class="related-grid">
				{#each data.compare as r (r.handle)}
					<a class="panel rel" href={`/materials/${r.handle}`}>
						<span class="rel-name">{r.name}</span>
						<span class="small muted">{r.blurb}</span>
						<span class="rel-price">{r.priceVaries ? 'from ' : ''}{money(r.pricePerGram)}/g</span>
					</a>
				{/each}
			</div>
		</section>
	{/if}
</div>

<style>
	.wrap {
		max-width: 1280px;
		margin: 0 auto;
		padding-left: var(--gutter-desktop);
		padding-right: var(--gutter-desktop);
	}

	.page {
		padding-top: 24px;
		padding-bottom: 80px;
		display: flex;
		flex-direction: column;
		gap: 32px;
	}

	h2 {
		font-size: 20px;
		line-height: 28px;
		font-weight: 600;
	}

	.crumbs {
		font: 12px var(--font-mono);
		color: var(--on-surface-variant);
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.crumbs a {
		color: var(--primary);
	}

	.crumbs a:hover {
		text-decoration: underline;
	}

	.panel {
		background: var(--surface-container-lowest);
		border: 1px solid var(--surface-container);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
	}

	.muted {
		color: var(--on-surface-variant);
	}

	.small {
		font-size: 13px;
		line-height: 1.5;
	}

	.hero {
		display: flex;
		flex-wrap: wrap;
		gap: 32px;
	}

	.gallery {
		flex: 1 1 520px;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.hero-photo {
		aspect-ratio: 4 / 3;
		border-radius: var(--radius-lg);
		overflow: hidden;
		transition: background-color 0.2s ease;
	}

	.hero-photo img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		background: var(--surface-container-lowest);
	}

	/* Print examples keep their own shape (many are wide banners) and show whole when picked. */
	.hero-photo.example {
		background: var(--surface-container-lowest);
		box-shadow: inset 0 0 0 1px var(--surface-container);
	}

	.hero-photo.example img {
		object-fit: contain;
	}

	.examples {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}

	.examples-label {
		font: 600 11px var(--font-mono);
		letter-spacing: 0.6px;
		text-transform: uppercase;
		color: var(--on-surface-variant);
	}

	.thumbs {
		display: flex;
		gap: 10px;
		overflow-x: auto;
		padding: 2px 2px 6px;
		scroll-snap-type: x proximity;
	}

	.thumb {
		flex: none;
		height: 88px;
		aspect-ratio: 1;
		border-radius: 6px;
		overflow: hidden;
		background: var(--surface-container);
		box-shadow: 0 0 0 1px var(--surface-container);
		scroll-snap-align: start;
	}

	.thumb:hover {
		box-shadow: 0 0 0 1px var(--outline-variant);
	}

	.thumb.on {
		box-shadow: 0 0 0 2px var(--primary);
	}

	.thumb img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.summary {
		flex: 1 1 420px;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.intro {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	h1 {
		font-size: 44px;
		line-height: 1.1;
		font-weight: 700;
		letter-spacing: -0.5px;
	}

	.description {
		font-size: 16px;
		line-height: 1.6;
		color: var(--on-surface-variant);
	}

	.description :global(p + p) {
		margin-top: 0.75em;
	}

	.description :global(strong) {
		color: var(--on-surface);
		font-weight: 600;
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.tag {
		font: 500 11px var(--font-mono);
		padding: 4px 8px;
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

	.buy {
		padding: 20px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.cost {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-size: 14px;
	}

	.big-price {
		font: 700 28px var(--font-mono);
	}

	.picker {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.picked {
		font-size: 13px;
		font-weight: 600;
	}

	.regular {
		font-weight: 400;
	}

	.stock {
		font: 500 11px var(--font-mono);
		color: #7a4a00;
	}

	.stock.ok {
		color: #00564f;
	}

	.lead-note {
		margin: 0;
		padding: 8px 12px;
		border: 1px solid var(--warning-border);
		border-radius: 8px;
		background: var(--warning-tint);
	}

	.swatch-row {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.group-label {
		font: 600 11px var(--font-mono);
		letter-spacing: 0.6px;
		text-transform: uppercase;
		color: var(--on-surface-variant);
	}

	.swatches {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.swatch {
		width: 44px;
		height: 44px;
		border-radius: var(--radius-lg);
		background: #fff;
		box-shadow: 0 0 0 1px var(--surface-container);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.swatch.on {
		box-shadow: 0 0 0 2px var(--primary);
	}

	.chip {
		width: 28px;
		height: 28px;
		border-radius: 6px;
		box-shadow: inset 0 0 0 1px rgb(19 27 46 / 0.12);
		flex: none;
	}

	.make {
		background: var(--primary);
		color: #fff;
		font-weight: 600;
		font-size: 15px;
		padding: 14px 18px;
		border-radius: var(--radius-md);
		text-align: center;
	}

	.make:hover {
		background: var(--primary-container);
	}

	.split {
		display: flex;
		flex-wrap: wrap;
		gap: 24px;
	}

	.split > * {
		flex: 1 1 460px;
		min-width: 0;
	}

	.perf {
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.bar {
		display: grid;
		grid-template-columns: 120px 1fr 80px;
		align-items: center;
		gap: 14px;
	}

	.bar-label {
		font-size: 14px;
		font-weight: 500;
	}

	.bar-word {
		font: 12px var(--font-mono);
		color: var(--on-surface-variant);
		text-align: right;
	}

	.segs {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 4px;
	}

	.seg {
		height: 10px;
		border-radius: 2px;
		background: var(--surface-container);
	}

	.seg.on {
		background: var(--primary);
	}

	.fit {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 16px;
	}

	.fit-card {
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.fit-card h2 {
		font-size: 16px;
		line-height: 24px;
	}

	.fit-card.good {
		border-top: 3px solid var(--secondary);
	}

	.fit-card.avoid {
		border-top: 3px solid var(--primary);
	}

	ul,
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	li {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		font-size: 14px;
		line-height: 1.5;
	}

	.mark {
		font-weight: 700;
	}

	.good .mark {
		color: var(--secondary);
	}

	.avoid .mark {
		color: var(--primary);
	}

	.colours {
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.colours-head {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
	}

	.colour-group {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding-top: 16px;
		border-top: 1px solid var(--surface-container-low);
	}

	.colour-group-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 6px 14px;
	}

	.colour-group-head h3 {
		font-size: 16px;
		line-height: 24px;
		font-weight: 600;
	}

	.colour-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 10px;
	}

	.colour {
		min-height: 44px;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px 8px 8px;
		border-radius: var(--radius-lg);
		border: 1px solid var(--surface-container);
		background: #fff;
		font-size: 13px;
		font-weight: 500;
		text-align: left;
	}

	.colour:hover {
		border-color: var(--outline-variant);
	}

	.colour.on {
		border-color: var(--primary);
		box-shadow: 0 0 0 1px var(--primary);
	}

	.colour-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.tech {
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	dl {
		margin: 8px 0 8px;
	}

	.spec {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 0;
		border-bottom: 1px solid var(--surface-container-low);
		font-size: 14px;
	}

	dt {
		color: var(--on-surface-variant);
	}

	dd {
		margin: 0;
		font-family: var(--font-mono);
		font-weight: 500;
		text-align: right;
	}

	.sheet {
		font-size: 13px;
		font-weight: 600;
		color: var(--primary);
		padding: 4px 0;
	}

	.sheet:hover {
		text-decoration: underline;
	}

	.tips {
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		background: var(--surface-container-low);
	}

	.tip-no {
		font-family: var(--font-mono);
		color: var(--primary);
		font-weight: 600;
	}

	.related {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.related-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 16px;
	}

	.rel {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 16px;
	}

	.rel:hover {
		border-color: var(--outline-variant);
	}

	.rel-name {
		font-weight: 600;
	}

	.rel-price {
		font: 600 13px var(--font-mono);
	}

	@media (max-width: 640px) {
		h1 {
			font-size: 34px;
		}

		.bar {
			grid-template-columns: 96px 1fr 72px;
			gap: 10px;
		}
	}
</style>
