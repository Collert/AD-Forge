<script lang="ts">
	import { molecule } from '$lib/catalog/molecules';

	/** Product `custom.molecule` key, e.g. "PETG". */
	let { name }: { name: string | undefined } = $props();

	let m = $derived(molecule(name));
</script>

{#if m}
	<svg class="molecule" viewBox={m.viewBox} width={m.width} height={m.height} aria-hidden="true">
		{#each m.lines as l, i (i)}
			<line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
		{/each}
		{#each m.rings as r, i (i)}
			<circle cx={r.cx} cy={r.cy} r="10.5" />
		{/each}
		{#each m.labels as l, i (i)}
			<text class="atom" x={l.x} y={l.y}>{l.t}</text>
		{/each}
		{#each m.subs as s, i (i)}
			<text class="sub" x={s.x} y={s.y}>{s.t}</text>
		{/each}
	</svg>
{/if}

<style>
	.molecule {
		display: block;
		overflow: visible;
	}

	line,
	circle {
		fill: none;
		stroke: var(--molecule-stroke, #6b7183);
		stroke-width: 1.4;
		stroke-linecap: round;
		transition: stroke 0.2s ease;
	}

	circle {
		stroke-width: 1.2;
	}

	.atom {
		font: 600 10px/1 var(--font-sans);
		fill: var(--primary);
		text-anchor: middle;
		dominant-baseline: central;
		/* Paint the label over its bonds, like a cut-out. */
		paint-order: stroke;
		stroke: var(--molecule-bg, var(--surface-container-low));
		stroke-width: 6px;
		stroke-linejoin: round;
	}

	.sub {
		font: italic 500 9px/1 var(--font-sans);
		fill: var(--on-surface-variant);
	}
</style>
