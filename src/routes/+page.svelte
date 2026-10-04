<script lang="ts">
	import { goto } from '$app/navigation';
	import { pendingUpload } from '$lib/upload.svelte';

	type Service = {
		icon: string;
		title: string;
		description: string;
		/** Configurator the card opens, `/make/<processId>`. */
		processId?: string;
		/** Lowest unit price with the biggest volume discount. */
		price?: string;
		comingSoon?: boolean;
	};

	/** The store's other (non-configurator) services. */
	const MORE_SERVICES_URL = 'https://adbits.ca/collections/services';

	const services: Service[] = [
		{
			icon: 'layers',
			title: 'Standard 3D Printing (FDM)',
			description:
				'Great for rapid prototypes, cosplay props, replacement brackets, and sturdy everyday parts. (PLA, PETG, ABS).',
			processId: 'fdm',
			price: 'From $0.50'
		},
		{
			icon: 'aspect_ratio',
			title: 'Large-Scale 3D Printing',
			description:
				'For big ideas, helmets, sculptures, and life-size models up to 450 mm in one solid piece without messy seams.',
			processId: 'large-fdm',
			price: 'From $0.50'
		},
		{
			icon: 'water_drop',
			title: 'Ultra-Detailed Resin (SLA)',
			description:
				'Glass-smooth finish and microscopic detail for figurines, miniatures, jewelry masters, and fine art pieces.',
			processId: 'sla',
			price: 'From $3'
		},
		{
			icon: 'precision_manufacturing',
			title: 'CNC Metal & Wood Machining',
			description:
				'Heavy-duty custom parts milled from solid aluminum, brass, or engineering plastics for precision mechanical projects.',
			processId: 'cnc',
			price: 'From $5'
		},
		{
			icon: 'memory',
			title: 'Custom PCB & Electronics',
			description:
				'Clean circuit boards and assembly for DIY IoT, custom keyboards, synthesizers, and robotics.',
			comingSoon: true
		},
		{
			icon: 'blur_linear',
			title: 'Laser Cutting & Engraving',
			description: 'Clean-cut acrylic, custom wooden signs, and custom laser-etched front panels.',
			comingSoon: true
		}
	];

	const steps = [
		{
			icon: 'upload_file',
			title: '1. Upload Model',
			description:
				'Drag in any standard 3D file or drawing. We check wall thickness and sizing automatically.'
		},
		{
			icon: 'palette',
			title: '2. Pick Material & Color',
			description:
				'Select plastics, resin, aluminum, or wood. Choose finishes and quantities with transparent pricing.'
		},
		{
			icon: 'local_shipping',
			title: '3. We Make & Ship',
			description:
				'Crafted on our machines, inspected for accuracy, and safely delivered right to your workshop or door.'
		}
	];

	const formats = ['.STL', '.3MF', '.OBJ', '.STEP', '.DXF', '.ZIP'];

	let fileInput = $state<HTMLInputElement>();
	let dragging = $state(false);
	let feedback = $state<string | null>(null);

	function handleFiles(files: FileList | null | undefined) {
		if (!files || files.length === 0) return;
		const file = files[0];
		const sizeMb = (file.size / 1024 / 1024).toFixed(2);
		feedback = `Opening ${file.name} (${sizeMb} MB) in the configurator...`;
		pendingUpload.file = file;
		goto('/make/fdm');
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		handleFiles(e.dataTransfer?.files);
	}

	function onDragOver(e: DragEvent) {
		e.preventDefault();
		dragging = true;
	}
</script>

<!-- Hero & CAD dropzone -->
<section class="hero" id="quote">
	<div class="hero-inner">
		<div class="hero-text">
			<h1>Turn Your Files into <span class="accent">Real Things.</span></h1>
			<p class="lead">
				Fast, reliable 3D printing, CNC, and custom making — built for hobbyists, artists, and
				engineers alike. No minimum orders, upfront pricing, and friendly support.
			</p>
		</div>

		<div class="upload-card">
			<div
				class="dropzone"
				class:dragging
				role="region"
				aria-label="File drop zone"
				ondragenter={onDragOver}
				ondragover={onDragOver}
				ondragleave={() => (dragging = false)}
				ondrop={onDrop}
			>
				<div class="dropzone-icon">
					<span class="material-symbols-outlined">cloud_upload</span>
				</div>
				<h2>Drop your 3D or design file here</h2>
				<p>Instant automated quote and thickness check in seconds.</p>
				<label class="btn-primary upload-btn">
					<span class="material-symbols-outlined icon-18">upload_file</span>
					<span>Start an Order / Upload File</span>
					<input
						bind:this={fileInput}
						type="file"
						accept=".stl,.obj,.3mf,.ply,.step,.stp,.sldprt,.dxf,.zip"
						hidden
						onchange={(e) => handleFiles(e.currentTarget.files)}
					/>
				</label>
				{#if feedback}
					<div class="feedback">
						<span class="ping-dot"></span>
						<span>{feedback}</span>
					</div>
				{/if}
			</div>
			<div class="formats">
				<span class="formats-label">Accepted formats:</span>
				{#each formats as format (format)}
					<span class="format-chip">{format}</span>
				{/each}
			</div>
		</div>

		<div class="trust">
			<div><span class="material-symbols-outlined icon-18 teal">verified</span>No Minimums (Make 1 or 1,000)</div>
			<div><span class="material-symbols-outlined icon-18 orange">bolt</span>Dispatches in 2-3 Days</div>
			<div><span class="material-symbols-outlined icon-18 teal">thumb_up</span>Satisfaction Guaranteed</div>
		</div>
	</div>
</section>

<!-- Manufacturing services grid -->
<section class="services" id="services">
	<div class="services-inner">
		<div class="section-head">
			<span class="eyebrow">MAKING CAPABILITIES</span>
			<h2 class="section-title">Everything You Need to Build It</h2>
			<p class="muted">
				Crafted with care on calibrated industrial machines. Choose a process to get started or
				view details.
			</p>
		</div>

		<div class="service-grid">
			{#each services as service (service.title)}
				<div class="service-card">
					<div class="service-body">
						<div class="service-icon" class:teal-tile={service.comingSoon}>
							<span class="material-symbols-outlined">{service.icon}</span>
						</div>
						<div class="service-title-row">
							<h3>{service.title}</h3>
							{#if service.comingSoon}
								<span class="soon-badge">Coming Soon</span>
							{/if}
						</div>
						<p class="muted">{service.description}</p>
					</div>
					<div class="service-foot">
						{#if service.comingSoon || !service.processId}
							<span class="early">Not available to order yet</span>
						{:else}
							<span class="price">{service.price}</span>
							<a class="card-link" href={`/make/${service.processId}`}>
								<span>Make with this</span>
								<span class="material-symbols-outlined icon-16">arrow_forward</span>
							</a>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		<a class="more-services" href={MORE_SERVICES_URL}>
			<span>More Services</span>
			<span class="material-symbols-outlined icon-18">arrow_forward</span>
		</a>
	</div>
</section>

<!-- How it works -->
<section class="how">
	<div class="how-inner">
		<div class="section-head narrow">
			<span class="eyebrow">HOW IT WORKS</span>
			<h2 class="section-title">Making Made Easy in Three Simple Steps</h2>
		</div>
		<div class="step-grid">
			{#each steps as step (step.title)}
				<div class="step">
					<div class="step-icon">
						<span class="material-symbols-outlined">{step.icon}</span>
					</div>
					<h3>{step.title}</h3>
					<p>{step.description}</p>
				</div>
			{/each}
		</div>
	</div>
</section>

<!-- Final CTA -->
<section class="cta">
	<div class="cta-card">
		<div class="cta-text">
			<h2>Have a custom project in mind?</h2>
			<p class="muted">
				Whether it's a creative art piece, custom cosplay prop, or precision engineering prototype,
				get an instant quote in seconds.
			</p>
		</div>
		<button class="btn-primary cta-btn" onclick={() => fileInput?.click()}>
			<span class="material-symbols-outlined icon-18">rocket_launch</span>
			<span>Start Your Project</span>
		</button>
	</div>
</section>

<style>
	.icon-16 {
		font-size: 16px;
	}

	.icon-18 {
		font-size: 18px;
	}

	.teal {
		color: var(--secondary);
	}

	.orange {
		color: var(--primary);
	}

	.muted {
		font-size: 14px;
		line-height: 20px;
		color: var(--on-surface-variant);
	}

	section {
		width: 100%;
		padding: var(--space-xl) var(--margin);
	}

	/* ---------- Hero ---------- */
	.hero {
		position: relative;
		overflow: hidden;
		background: var(--surface);
	}

	/* Stacked on mobile; from 1024px the text and trust badges sit left of the upload card. */
	.hero-inner {
		max-width: 56rem;
		margin: 0 auto;
		display: grid;
		grid-template-areas: 'text' 'upload' 'trust';
		justify-items: center;
		text-align: center;
		gap: var(--space-lg);
	}

	.hero-text {
		grid-area: text;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-lg);
	}

	.ping-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--secondary);
		flex-shrink: 0;
		animation: ping 1s cubic-bezier(0, 0, 0.2, 1) infinite;
	}

	@keyframes ping {
		75%,
		100% {
			transform: scale(2);
			opacity: 0;
		}
	}

	h1 {
		max-width: 48rem;
		font-size: 32px;
		line-height: 1.25;
		font-weight: 700;
		letter-spacing: -0.025em;
		color: var(--on-surface);
	}

	.accent {
		color: var(--primary);
	}

	.lead {
		max-width: 42rem;
		font-size: 16px;
		line-height: 24px;
		color: var(--on-surface-variant);
	}

	.upload-card {
		grid-area: upload;
		width: 100%;
		max-width: 42rem;
		margin-top: var(--space-sm);
		padding: var(--space-lg);
		background: var(--surface-container-lowest);
		border: 1px solid var(--surface-container);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-md);
	}

	.dropzone {
		width: 100%;
		padding: var(--space-lg);
		border: 2px dashed rgb(226 191 178 / 0.4);
		border-radius: var(--radius-lg);
		background: var(--surface-container-low);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		cursor: pointer;
		transition: background-color 0.15s ease;
	}

	.dropzone:hover {
		background: var(--surface-container);
	}

	.dropzone.dragging {
		background: var(--surface-container-highest);
	}

	.dropzone-icon {
		width: 3.5rem;
		height: 3.5rem;
		margin-bottom: var(--space-sm);
		border-radius: var(--radius-full);
		background: var(--primary-tint);
		color: var(--primary);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.dropzone-icon .material-symbols-outlined {
		font-size: 32px;
	}

	.dropzone h2 {
		margin-bottom: 0.25rem;
		font-size: 20px;
		line-height: 28px;
		font-weight: 600;
		letter-spacing: -0.015em;
		color: var(--on-surface);
	}

	.dropzone p {
		max-width: 28rem;
		margin-bottom: var(--space-md);
		color: var(--on-surface-variant);
	}

	.upload-btn {
		padding: var(--space-sm) var(--space-lg);
	}

	.feedback {
		width: 100%;
		max-width: 28rem;
		margin-top: var(--space-md);
		padding: var(--space-sm);
		border-radius: var(--radius-md);
		background: var(--secondary-container);
		color: var(--on-secondary-container);
		font-size: 12px;
		line-height: 16px;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
	}

	.formats {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: var(--space-xs);
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 14px;
		color: var(--on-surface-variant);
	}

	.formats-label {
		margin-right: 0.25rem;
		font-weight: 600;
		color: var(--on-surface);
	}

	.format-chip {
		padding: 0.125rem 0.5rem;
		border-radius: var(--radius-sm);
		background: var(--surface-container);
		font-size: 12px;
		line-height: 16px;
		font-weight: 500;
		letter-spacing: 0.02em;
	}

	.trust {
		grid-area: trust;
		margin-top: var(--space-xs);
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: var(--space-lg);
		font-size: 12px;
		line-height: 16px;
		color: var(--on-surface-variant);
	}

	.trust div {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	/* ---------- Services ---------- */
	.services {
		background: var(--surface-container-low);
	}

	.services-inner {
		max-width: 80rem;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-xl);
	}

	.section-head {
		max-width: 42rem;
		margin: 0 auto;
		text-align: center;
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}

	.section-head.narrow {
		max-width: 36rem;
	}

	.service-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-lg);
	}

	.service-card {
		padding: var(--space-lg);
		background: var(--surface-container-lowest);
		border: 1px solid var(--surface-container);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		transition: transform 0.2s ease;
	}

	.service-card:hover {
		transform: translateY(-0.25rem);
	}

	.service-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		text-align: left;
	}

	.service-icon {
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius-md);
		background: var(--primary-tint);
		color: var(--primary);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.service-icon.teal-tile {
		background: var(--secondary-tint);
		color: var(--secondary);
	}

	.service-title-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.service-card h3 {
		font-size: 18px;
		line-height: 28px;
		font-weight: 600;
		letter-spacing: -0.015em;
		color: var(--on-surface);
	}

	.soon-badge {
		padding: 0.125rem 0.375rem;
		border-radius: var(--radius-sm);
		background: var(--secondary-container);
		color: var(--on-secondary-container);
		font-family: var(--font-mono);
		font-size: 9px;
		line-height: 14px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.service-foot {
		margin-top: var(--space-lg);
		padding-top: var(--space-sm);
		border-top: 1px solid var(--surface-container);
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.price {
		font-family: var(--font-mono);
		font-size: 14px;
		line-height: 20px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--on-surface);
	}

	.early {
		font-size: 12px;
		line-height: 16px;
		color: var(--on-surface-variant);
	}

	.card-link {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 13px;
		font-weight: 600;
		color: var(--primary);
		transition: color 0.15s ease;
	}

	.card-link:hover {
		color: var(--primary-container);
	}

	.more-services {
		align-self: center;
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-sm) var(--space-lg);
		border: 1px solid var(--primary);
		border-radius: var(--radius-md);
		color: var(--primary);
		font-size: 14px;
		font-weight: 600;
		text-decoration: none;
		transition:
			background-color 0.15s ease,
			color 0.15s ease;
	}

	.more-services:hover {
		background: var(--primary);
		color: var(--on-primary);
	}

	/* ---------- How it works ---------- */
	.how {
		background: var(--surface);
	}

	.how-inner {
		max-width: 64rem;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
		text-align: center;
	}

	.step-grid {
		margin-top: var(--space-md);
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-lg);
	}

	.step {
		padding: var(--space-md);
		border-radius: var(--radius-lg);
		background: var(--surface-container-low);
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
	}

	.step-icon {
		width: 3rem;
		height: 3rem;
		margin-bottom: var(--space-sm);
		border-radius: var(--radius-full);
		background: var(--primary);
		color: var(--on-primary);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.step h3 {
		margin-bottom: 0.25rem;
		font-size: 16px;
		line-height: 24px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--on-surface);
	}

	.step p {
		font-size: 12px;
		line-height: 16px;
		color: var(--on-surface-variant);
	}

	/* ---------- CTA ---------- */
	.cta {
		background: var(--surface);
	}

	.cta-card {
		max-width: 56rem;
		margin: 0 auto;
		padding: var(--space-lg);
		background: var(--surface-container-lowest);
		border: 1px solid var(--surface-container);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-lg);
	}

	.cta-text {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		text-align: center;
	}

	.cta-text h2 {
		font-size: 24px;
		line-height: 36px;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--on-surface);
	}

	.cta-text p {
		max-width: 32rem;
	}

	.cta-btn {
		flex-shrink: 0;
		padding: var(--space-sm) var(--space-xl);
		font-size: 14px;
	}

	/* ---------- Breakpoints ---------- */
	@media (min-width: 768px) {
		section {
			padding: 5rem var(--gutter-desktop);
		}

		.how,
		.cta {
			padding-top: 4rem;
			padding-bottom: 4rem;
		}

		h1 {
			font-size: 48px;
		}

		.dropzone {
			padding: 3rem;
		}

		.service-grid {
			grid-template-columns: repeat(2, 1fr);
		}

		.step-grid {
			grid-template-columns: repeat(3, 1fr);
		}

		.cta-card {
			flex-direction: row;
			padding: 3rem;
		}

		.cta-text {
			text-align: left;
		}
	}

	@media (min-width: 1024px) {
		.service-grid {
			grid-template-columns: repeat(3, 1fr);
		}

		.hero-inner {
			max-width: 80rem;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			/* Empty rows above and below centre the text and badges, together, beside the card. */
			grid-template-rows: 1fr auto auto 1fr;
			grid-template-areas: '. upload' 'text upload' 'trust upload' '. upload';
			row-gap: 0;
			column-gap: var(--space-xl);
			align-items: center;
			justify-items: start;
			text-align: left;
		}

		.hero-text {
			align-items: flex-start;
		}

		.trust {
			margin-top: var(--space-lg);
			justify-content: flex-start;
		}

		.upload-card {
			max-width: none;
			margin-top: 0;
		}
	}
</style>
