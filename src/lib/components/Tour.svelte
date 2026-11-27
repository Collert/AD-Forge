<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { markTourDone, type Tour, type TourStep } from '$lib/tour/tours';

	type Props = {
		tour: Tour | null;
		open?: boolean;
		/** Runs as the tour opens, to put the page in the state the steps describe. */
		onstart?: () => void;
	};

	let { tour, open = $bindable(false), onstart }: Props = $props();

	/** Space between the spotlight and its element, and between the spotlight and the card. */
	const PAD = 8;
	const GAP = 14;
	/** Keeps the card clear of the viewport edges (and the fixed site header when scrolling). */
	const EDGE = 16;
	const HEADER = 72;

	type Box = { x: number; y: number; w: number; h: number };

	/** The steps whose elements were on the page when the tour opened. */
	let steps = $state.raw<TourStep[]>([]);
	let index = $state(0);
	let step = $derived(steps[index]);
	let hole = $state<Box | null>(null);
	let vw = $state(0);
	let vh = $state(0);
	let cardW = $state(0);
	let cardH = $state(0);
	let card = $state<HTMLElement>();

	const find = (target?: string) =>
		target ? document.querySelector<HTMLElement>(`[data-tour="${target}"]`) : null;
	const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

	$effect(() => {
		if (!open || !tour) return;
		untrack(start);
	});

	async function start() {
		onstart?.();
		await tick();
		steps = tour!.steps.filter((s) => !s.target || find(s.target));
		go(0);
	}

	async function go(i: number) {
		index = i;
		const el = find(steps[i]?.target);
		if (el) {
			const behavior = reducedMotion() ? 'instant' : 'smooth';
			if (vw < 640) {
				// The card docks to the bottom on phones, so bring the element up near the header.
				scrollTo({ top: el.getBoundingClientRect().top + scrollY - HEADER - EDGE, behavior });
			} else {
				el.scrollIntoView({ block: 'center', behavior });
			}
		}
		await tick();
		card?.focus({ preventScroll: true });
	}

	// Follow the element while the page scrolls, resizes or reflows.
	$effect(() => {
		if (!open || !step) return;
		const el = find(step.target);
		let frame = 0;
		const measure = () => {
			if (el?.isConnected) {
				const r = el.getBoundingClientRect();
				const next = { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };
				if (!hole || next.x !== hole.x || next.y !== hole.y || next.w !== hole.w || next.h !== hole.h) hole = next;
			} else if (hole) {
				hole = null;
			}
			frame = requestAnimationFrame(measure);
		};
		measure();
		return () => cancelAnimationFrame(frame);
	});

	/** The spotlight, trimmed to the viewport. */
	let visible = $derived.by((): Box | null => {
		if (!hole) return null;
		const x = Math.max(hole.x, 0);
		const y = Math.max(hole.y, 0);
		const w = Math.min(hole.x + hole.w, vw) - x;
		const h = Math.min(hole.y + hole.h, vh) - y;
		return w > 0 && h > 0 ? { x, y, w, h } : null;
	});

	/** Dims and blocks everything except the spotlight, which stays clickable. */
	let clip = $derived(
		visible
			? `path(evenodd, 'M0 0H${vw}V${vh}H0Z M${visible.x} ${visible.y}H${visible.x + visible.w}V${visible.y + visible.h}H${visible.x}Z')`
			: 'none'
	);

	/** Below the element if it fits, else above, else beside it, else over its bottom edge. */
	let cardPos = $derived.by((): { left: number; top: number } | null => {
		if (!visible || vw < 640) return null;
		const clampX = (x: number) => Math.min(Math.max(x, EDGE), vw - cardW - EDGE);
		const clampY = (y: number) => Math.min(Math.max(y, HEADER), vh - cardH - EDGE);
		const centerX = clampX(visible.x + visible.w / 2 - cardW / 2);
		const centerY = clampY(visible.y + visible.h / 2 - cardH / 2);
		const below = visible.y + visible.h + GAP;
		const above = visible.y - GAP - cardH;
		const right = visible.x + visible.w + GAP;
		const left = visible.x - GAP - cardW;
		if (below + cardH <= vh - EDGE) return { left: centerX, top: below };
		if (above >= HEADER) return { left: centerX, top: above };
		if (right + cardW <= vw - EDGE) return { left: right, top: centerY };
		if (left >= EDGE) return { left, top: centerY };
		return { left: centerX, top: clampY(visible.y + visible.h - cardH - GAP) };
	});

	let last = $derived(index === steps.length - 1);

	function finish() {
		if (tour) markTourDone(tour.id);
		open = false;
		hole = null;
	}

	function next() {
		if (last) finish();
		else go(index + 1);
	}

	function back() {
		if (index > 0) go(index - 1);
	}

	function onkeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			finish();
			return;
		}
		// Leave arrow keys to sliders, selects and text fields inside the spotlight.
		const t = e.target as HTMLElement;
		if (t.closest('input, select, textarea, [contenteditable]')) return;
		if (e.key === 'ArrowRight') {
			e.preventDefault();
			next();
		} else if (e.key === 'ArrowLeft') {
			e.preventDefault();
			back();
		}
	}
</script>

<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} {onkeydown} />

{#if open && step}
	<div class="tour">
		<div class="scrim" style:clip-path={clip}></div>
		{#if visible}
			<div
				class="ring"
				style:left="{visible.x}px"
				style:top="{visible.y}px"
				style:width="{visible.w}px"
				style:height="{visible.h}px"
			></div>
		{/if}

		<div
			bind:this={card}
			bind:offsetWidth={cardW}
			bind:offsetHeight={cardH}
			class="card"
			class:centered={!step.target}
			class:docked={!!step.target && !cardPos}
			style:left={cardPos ? `${cardPos.left}px` : null}
			style:top={cardPos ? `${cardPos.top}px` : null}
			role="dialog"
			aria-labelledby="tour-title"
			aria-describedby="tour-body"
			tabindex="-1"
		>
			<div class="progress" aria-hidden="true">
				<span style:width="{((index + 1) / steps.length) * 100}%"></span>
			</div>
			<div class="head">
				<span class="count">Step {index + 1} of {steps.length}</span>
				<button type="button" class="skip" onclick={finish}>{last ? 'Close' : 'Skip tour'}</button>
			</div>
			<h2 id="tour-title">{step.title}</h2>
			<p id="tour-body" aria-live="polite">{step.body}</p>
			<div class="actions">
				{#if index > 0}
					<button type="button" class="btn back" onclick={back}>
						<span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>Back
					</button>
				{/if}
				<button type="button" class="btn next" onclick={next}>
					{#if last}
						<span class="material-symbols-outlined" aria-hidden="true">check</span>Finish
					{:else}
						Next<span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.tour {
		position: fixed;
		inset: 0;
		z-index: 1000;
		pointer-events: none;
	}

	.scrim {
		position: absolute;
		inset: 0;
		background: rgb(15 23 42 / 0.55);
		pointer-events: auto;
		transition: clip-path 0.25s ease;
	}

	.ring {
		position: absolute;
		border: 2px solid var(--primary);
		border-radius: var(--radius-lg);
		box-shadow: 0 0 0 4px rgb(163 57 0 / 0.25);
		transition:
			left 0.25s ease,
			top 0.25s ease,
			width 0.25s ease,
			height 0.25s ease;
	}

	.card {
		position: absolute;
		width: min(360px, calc(100vw - 2rem));
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		padding: var(--space-md) var(--space-lg) var(--space-lg);
		border: 1px solid var(--outline-variant);
		border-radius: var(--radius-lg);
		background: var(--surface-container-lowest);
		color: var(--on-surface);
		box-shadow: 0 10px 30px rgb(0 0 0 / 0.2);
		pointer-events: auto;
		outline: none;
		transition:
			left 0.25s ease,
			top 0.25s ease;
	}

	.card.centered {
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		transition: none;
	}

	/* Phones, and elements with no room around them: dock to the bottom of the screen. */
	.card.docked {
		left: 1rem;
		right: 1rem;
		bottom: 1rem;
		width: auto;
		max-width: 480px;
		margin: 0 auto;
		transition: none;
	}

	.progress {
		height: 3px;
		border-radius: 2px;
		background: var(--surface-container-high);
		overflow: hidden;
	}

	.progress span {
		display: block;
		height: 100%;
		background: var(--primary);
		transition: width 0.25s ease;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.count {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--primary);
	}

	.skip {
		padding: 2px 6px;
		border: none;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--on-surface-variant);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}

	.skip:hover,
	.skip:focus-visible {
		background: var(--surface-container-high);
		color: var(--on-surface);
	}

	h2 {
		margin: 0;
		font-size: 16px;
		line-height: 24px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	p {
		margin: 0;
		font-size: 14px;
		line-height: 21px;
		color: var(--on-surface-variant);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-sm);
		margin-top: var(--space-xs);
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 8px 14px;
		border-radius: var(--radius-md);
		font: inherit;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}

	.btn .material-symbols-outlined {
		font-size: 18px;
	}

	.back {
		border: 1px solid var(--outline-variant);
		background: transparent;
		color: var(--on-surface);
	}

	.back:hover {
		background: var(--surface-container-low);
	}

	.next {
		border: 1px solid var(--primary);
		background: var(--primary);
		color: var(--on-primary);
	}

	.next:hover {
		background: var(--primary-container);
	}

	.btn:focus-visible,
	.skip:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}

	@media (prefers-reduced-motion: reduce) {
		.scrim,
		.ring,
		.card,
		.progress span {
			transition: none;
		}
	}
</style>
