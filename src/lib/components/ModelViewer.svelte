<!--
	@component
	Interactive three.js preview of a printable part sitting on a build plate.

	Loads STL / OBJ / 3MF / PLY / STEP / IGES from a `File` or URL (drag-and-drop too), shows
	full orbit/zoom/pan (the bed turns see-through from below), camera presets,
	a measuring box, overhang highlighting, a layer-by-layer cut preview, and
	rotate / scale editing with a "try to fit" orientation search. Edits are
	baked into the mesh, so `bind:info` (size, volume, overhangs,
	watertightness, bed fit) always describes the edited part. Bind
	`transform` to send the edits on, or call `exportModel()` for an STL.

	```svelte
	<ModelViewer bind:source={file} color="#f59e0b" bed={{ x: 250, y: 250, z: 250 }} bind:info />
	```
-->
<script lang="ts">
	import { onMount, untrack, type Snippet } from 'svelte';
	import type { BufferGeometry } from 'three';
	import type { BedSize, ModelInfo } from '$lib/viewer/analysis';
	import { MODEL_ACCEPT } from '$lib/viewer/formats';
	import type { ModelSource } from '$lib/viewer/load-model';
	import type { OrientationFit } from '$lib/viewer/orient';
	import type { ThicknessProfile } from '$lib/viewer/thickness';
	import type { MachiningProfile } from '$lib/viewer/machining';
	import type { AnalysisKind } from '$lib/viewer/analysis.worker';
	import type { ViewerScene, ViewPreset } from '$lib/viewer/scene';
	import {
		clampScale,
		identityTransform,
		normalizeAngle,
		type ModelTransform
	} from '$lib/viewer/transform';

	type Axis = 'x' | 'y' | 'z';

	type Props = {
		/** File or URL of the model. `null` shows the placeholder part (or an empty bed). */
		source?: ModelSource | null;
		/** Force a format instead of inferring it from the file name. */
		format?: string;
		/** Filament / material colour. */
		color?: string;
		/** Machine build volume in mm. */
		bed?: BedSize;
		/** Text for the top-left HUD chip. Defaults to the bed footprint. */
		bedLabel?: string;
		/** Used for the layer preview slider. */
		layerHeight?: number;
		/** Degrees from vertical beyond which downward faces count as overhangs. */
		overhangAngle?: number;
		/** Also analyse CNC tool access (fills `info.machining`). */
		machining?: boolean;
		/** Show a sample part when there's no source. */
		placeholder?: boolean;
		/** Accept files dropped on the viewport / picked with the open button. */
		allowDrop?: boolean;
		/** Allow rotating / scaling the part. */
		editable?: boolean;
		/** Show the toolbar, layer slider and chips. */
		hud?: boolean;
		/** Show the layer-by-layer cut slider (off for processes without layers, like CNC). */
		layers?: boolean;
		/** Show the bottom dimensions / volume / fit bar. */
		stats?: boolean;
		/** CSS height of the viewport. */
		height?: string;
		autoRotate?: boolean;
		showOverhangs?: boolean;
		showMeasure?: boolean;
		/** Rotation + scale baked into the part. Resets when a new model loads. */
		transform?: ModelTransform;
		/** Latest analysis of the displayed (transformed) part (read-only). */
		info?: ModelInfo | null;
		/** Result of the last "Try to fit" (read-only). */
		orientationFit?: OrientationFit;
		onload?: (info: ModelInfo) => void;
		onerror?: (error: Error) => void;
		/** Extra overlay content, rendered above the canvas. */
		children?: Snippet;
	};

	let {
		source = $bindable(null),
		format,
		color = '#f59e0b',
		bed = { x: 250, y: 250, z: 250 },
		bedLabel,
		layerHeight = 0.2,
		overhangAngle = 45,
		machining = false,
		placeholder = true,
		allowDrop = true,
		editable = true,
		hud = true,
		layers = true,
		stats = true,
		height = '520px',
		autoRotate = $bindable(false),
		showOverhangs = $bindable(false),
		showMeasure = $bindable(false),
		transform = $bindable(identityTransform()),
		info = $bindable(null),
		orientationFit = $bindable(null),
		onload,
		onerror,
		children
	}: Props = $props();

	const views: { id: ViewPreset; label: string }[] = [
		{ id: 'iso', label: 'Iso' },
		{ id: 'top', label: 'Top' },
		{ id: 'front', label: 'Front' },
		{ id: 'side', label: 'Side' },
		{ id: 'bottom', label: 'Bottom' }
	];
	const axes: Axis[] = ['x', 'y', 'z'];
	const INCH_MM = 25.4;

	/** The model exactly as loaded (Z-up, mm), before any transform. */
	type BaseModel = {
		id: number;
		geometry: BufferGeometry;
		name: string;
		openEdges: number;
		placeholder: boolean;
		hull?: Float32Array;
	};

	let container = $state<HTMLDivElement>();
	let fileInput = $state<HTMLInputElement>();
	let viewer = $state.raw<ViewerScene | null>(null);
	let base = $state.raw<BaseModel | null>(null);
	let status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let errorMessage = $state('');
	let analysis = $state.raw<ModelInfo | null>(null);
	let dragging = $state(false);
	let activeView = $state<ViewPreset>('iso');
	let webglFailed = $state(false);
	let panel = $state<'rotate' | 'scale' | null>(null);
	let scaleLocked = $state(true);
	let fitting = $state(false);
	let fitResult = $state.raw<{ key: string; status: NonNullable<OrientationFit> } | null>(null);

	let baseCounter = 0;
	/** Re-frame the camera on the next rebuild (new model, or after "Try to fit"). */
	let refitCamera = true;
	/** Fire `onload` on the next rebuild (only for a newly loaded model). */
	let notifyLoad = false;

	let totalLayers = $derived(analysis ? Math.max(1, Math.ceil(analysis.size.z / layerHeight)) : 0);
	let cutLayer = $state<number | null>(null);
	let shownLayer = $derived(cutLayer === null ? totalLayers : Math.min(cutLayer, totalLayers));

	/** Size of the rotated part at 100% scale — the reference for % ↔ mm. */
	let unscaledSize = $derived(
		analysis
			? {
					x: analysis.size.x / transform.scale.x,
					y: analysis.size.y / transform.scale.y,
					z: analysis.size.z / transform.scale.z
				}
			: null
	);

	/** A fit result only holds for the model, scale and bed it was computed with. */
	let fitKey = $derived(base ? JSON.stringify([base.id, transform.scale, bed]) : '');
	let fitStatus = $derived(fitResult && fitResult.key === fitKey ? fitResult.status : null);

	const fits = (a: ModelInfo, b: BedSize) => a.size.x <= b.x && a.size.y <= b.y && a.size.z <= b.z;

	/**
	 * Thickness depends on the model and its scale. Scale is applied after rotation, so
	 * rotation only matters once the scale is non-uniform.
	 */
	let thicknessKey = $derived.by(() => {
		if (!base) return '';
		const { x, y, z } = transform.scale;
		return JSON.stringify(x === y && y === z ? [base.id, x] : [base.id, transform]);
	});
	/** Tool access depends on orientation too. Empty when machining analysis is off. */
	let machiningKey = $derived(base && machining ? JSON.stringify([base.id, transform]) : '');

	type Results = { thickness: ThicknessProfile; machining: MachiningProfile };
	let results = $state.raw<{ [K in AnalysisKind]?: { key: string; profile: Results[K] } }>({});
	let analysisWorker: Worker | null = null;
	/** The job in flight per kind; a reply with any other id is stale. */
	const jobs: Record<AnalysisKind, { id: number; key: string }> = {
		thickness: { id: 0, key: '' },
		machining: { id: 0, key: '' }
	};
	const currentKey = (kind: AnalysisKind) => (kind === 'thickness' ? thicknessKey : machiningKey);
	const resultFor = <K extends AnalysisKind>(kind: K) => {
		const r = results[kind];
		return r && r.key === currentKey(kind) ? (r.profile as Results[K]) : null;
	};

	$effect(() => {
		info = analysis
			? {
					...analysis,
					fitsBed: fits(analysis, bed),
					thickness: resultFor('thickness'),
					machining: resultFor('machining')
				}
			: null;
	});

	// Heavier mesh analyses run off the main thread, once edits settle.
	$effect(() => scheduleAnalysis('thickness', thicknessKey));
	$effect(() => scheduleAnalysis('machining', machiningKey));

	function scheduleAnalysis(kind: AnalysisKind, key: string) {
		const model = base;
		const t = transform;
		if (!model || !key || untrack(() => results[kind]?.key) === key || jobs[kind].key === key) return;
		const timer = setTimeout(() => runAnalysis(kind, model, t, key), 300);
		return () => clearTimeout(timer);
	}

	async function runAnalysis(kind: AnalysisKind, model: BaseModel, t: ModelTransform, key: string) {
		const [{ default: AnalysisWorker }, { applyTransform }] = await Promise.all([
			import('$lib/viewer/analysis.worker?worker'),
			import('$lib/viewer/transform')
		]);
		if (key !== currentKey(kind)) return;
		if (!analysisWorker) {
			analysisWorker = new AnalysisWorker();
			analysisWorker.onmessage = (e: MessageEvent<{ kind: AnalysisKind; id: number; profile: Results[AnalysisKind] }>) => {
				const { kind, id, profile } = e.data;
				if (id === jobs[kind].id) results = { ...results, [kind]: { key: jobs[kind].key, profile } };
			};
		}
		const edited = applyTransform(model.geometry, t);
		const positions = new Float32Array(edited.getAttribute('position').array as ArrayLike<number>);
		edited.dispose();
		jobs[kind] = { id: jobs[kind].id + 1, key };
		analysisWorker.postMessage({ kind, id: jobs[kind].id, positions }, [positions.buffer]);
	}

	$effect(() => {
		orientationFit = fitStatus;
	});

	onMount(() => {
		let disposed = false;
		let instance: ViewerScene | null = null;
		const css = getComputedStyle(container!);
		const token = (name: string, fallback: string) =>
			css.getPropertyValue(name).trim() || fallback;

		import('$lib/viewer/scene').then(({ ViewerScene }) => {
			if (disposed) return;
			try {
				instance = new ViewerScene(container!, {
					accent: token('--primary', '#a33900'),
					overhang: token('--error', '#ba1a1a'),
					plate: '#f8fafc',
					gridMinor: '#dbe2ec',
					gridMajor: '#b6c2d3',
					frame: '#94a3b8'
				});
				viewer = instance;
			} catch (err) {
				webglFailed = true;
				onerror?.(err as Error);
			}
		});

		return () => {
			disposed = true;
			instance?.dispose();
			viewer = null;
			analysisWorker?.terminate();
			base?.geometry.dispose();
		};
	});

	// Load whatever `source` points at (or the placeholder part).
	$effect(() => {
		const v = viewer;
		const src = source;
		const fmt = format;
		const usePlaceholder = placeholder;
		if (!v) return;

		const controller = new AbortController();
		load(v, src, fmt, usePlaceholder, controller.signal);
		return () => controller.abort();
	});

	async function load(
		v: ViewerScene,
		src: ModelSource | null,
		fmt: string | undefined,
		usePlaceholder: boolean,
		signal: AbortSignal
	) {
		const [{ loadModel, formatOf, nameOf, isStoredModel }, { countOpenEdges }] = await Promise.all([
			import('$lib/viewer/load-model'),
			import('$lib/viewer/analysis')
		]);
		if (signal.aborted) return;

		errorMessage = '';
		const replaceBase = (next: BaseModel | null) => {
			base?.geometry.dispose();
			base = next;
		};

		if (!src && !usePlaceholder) {
			replaceBase(null);
			v.setGeometry(null);
			analysis = null;
			status = 'idle';
			return;
		}

		status = 'loading';
		try {
			let geometry;
			let name;
			if (src) {
				geometry = await loadModel(src, fmt ?? formatOf(src), signal);
				name = nameOf(src);
			} else {
				const { createDemoPart } = await import('$lib/viewer/demo-part');
				geometry = createDemoPart();
				name = 'sample-flanged-collar.stl';
			}
			if (signal.aborted) {
				geometry.dispose();
				return;
			}

			refitCamera = true;
			notifyLoad = true;
			activeView = 'iso';
			transform =
				isStoredModel(src) && src.transform
					? (JSON.parse(JSON.stringify(src.transform)) as ModelTransform)
					: identityTransform();
			replaceBase({
				id: ++baseCounter,
				geometry,
				name,
				openEdges: countOpenEdges(geometry),
				placeholder: !src
			});
			status = 'ready';
		} catch (err) {
			if (signal.aborted) return;
			replaceBase(null);
			v.setGeometry(null);
			analysis = null;
			status = 'error';
			errorMessage = (err as Error).message;
			onerror?.(err as Error);
		}
	}

	// Bake the transform into the displayed part whenever the model or transform changes.
	$effect(() => {
		const v = viewer;
		const model = base;
		const t = transform;
		if (!v || !model) return;
		untrack(() => rebuild(v, model, t));
	});

	async function rebuild(v: ViewerScene, model: BaseModel, t: ModelTransform) {
		const [{ applyTransform }, { analyzeGeometry }] = await Promise.all([
			import('$lib/viewer/transform'),
			import('$lib/viewer/analysis')
		]);
		if (base !== model || transform !== t) return;

		const edited = applyTransform(model.geometry, t);
		const placed = v.setGeometry(edited, refitCamera)!;
		edited.dispose();
		const result = analyzeGeometry(placed, model.name, bed, overhangAngle, model.openEdges);
		placed.dispose();

		if (refitCamera) activeView = 'iso';
		refitCamera = false;
		cutLayer = null;
		analysis = result;
		if (notifyLoad) {
			notifyLoad = false;
			onload?.({ ...result, fitsBed: fits(result, bed) });
		}
	}

	$effect(() => viewer?.setColor(color));
	$effect(() => viewer?.setBed({ x: bed.x, y: bed.y, z: bed.z }));
	$effect(() => viewer?.setOverhangs(showOverhangs, overhangAngle));
	// Keep the reported overhang area in step with the threshold without a full rebuild.
	$effect(() => {
		const v = viewer;
		const angle = overhangAngle;
		untrack(() => {
			const area = v?.overhangArea(angle);
			if (analysis && area != null && area !== analysis.overhangArea) {
				analysis = { ...analysis, overhangArea: area };
			}
		});
	});
	$effect(() => viewer?.setMeasure(showMeasure));
	$effect(() => viewer?.setAutoRotate(autoRotate));
	$effect(() => {
		if (!layers) untrack(() => (cutLayer = null));
	});
	$effect(() => {
		const layer = cutLayer;
		viewer?.setCut(layer === null || layer >= totalLayers ? null : layer * layerHeight);
	});

	// ---------- Rotation ----------

	function setRotation(axis: Axis, degrees: number) {
		if (!Number.isFinite(degrees)) return;
		transform = {
			...transform,
			rotation: { ...transform.rotation, [axis]: normalizeAngle(Math.round(degrees * 100) / 100) }
		};
	}

	function resetRotation() {
		transform = { ...transform, rotation: { x: 0, y: 0, z: 0 } };
	}

	async function tryToFit() {
		if (!base || fitting) return;
		const model = base;
		const t = transform;
		const key = fitKey;
		fitting = true;
		// Let the "Searching…" state paint before the synchronous search runs.
		await new Promise((r) => setTimeout(r, 30));
		try {
			const { findFittingRotation, hullPoints } = await import('$lib/viewer/orient');
			model.hull ??= hullPoints(model.geometry);
			const result = findFittingRotation(model.hull, t, { x: bed.x, y: bed.y, z: bed.z });
			if (base !== model) return;
			if (result.status === 'rotated') {
				refitCamera = true;
				transform = { ...transform, rotation: result.rotation };
			}
			fitResult = { key, status: result.status };
		} finally {
			fitting = false;
		}
	}

	// ---------- Scale ----------

	function setScale(axis: Axis, factor: number) {
		if (!Number.isFinite(factor) || factor <= 0) return;
		const f = clampScale(factor);
		const scale = scaleLocked
			? (() => {
					const ratio = f / transform.scale[axis];
					return {
						x: clampScale(transform.scale.x * ratio),
						y: clampScale(transform.scale.y * ratio),
						z: clampScale(transform.scale.z * ratio)
					};
				})()
			: { ...transform.scale, [axis]: f };
		transform = { ...transform, scale };
	}

	function setScalePercent(axis: Axis, percent: number) {
		setScale(axis, percent / 100);
	}

	function setSizeMm(axis: Axis, size: number) {
		if (!unscaledSize || unscaledSize[axis] === 0) return;
		setScale(axis, size / unscaledSize[axis]);
	}

	function multiplyScale(k: number) {
		const s = transform.scale;
		transform = {
			...transform,
			scale: { x: clampScale(s.x * k), y: clampScale(s.y * k), z: clampScale(s.z * k) }
		};
	}

	function resetScale() {
		transform = { ...transform, scale: { x: 1, y: 1, z: 1 } };
	}

	function togglePanel(name: 'rotate' | 'scale') {
		panel = panel === name ? null : name;
	}

	// ---------- Misc ----------

	function setView(preset: ViewPreset) {
		activeView = preset;
		viewer?.view(preset);
	}

	function onLayerInput(e: Event & { currentTarget: HTMLInputElement }) {
		const value = Number(e.currentTarget.value);
		cutLayer = value >= totalLayers ? null : value;
	}

	function takeFile(files: FileList | null | undefined) {
		const file = files?.[0];
		if (file) source = file;
	}

	function onDrop(e: DragEvent) {
		if (!allowDrop) return;
		e.preventDefault();
		dragging = false;
		takeFile(e.dataTransfer?.files);
	}

	function onDragOver(e: DragEvent) {
		if (!allowDrop || !e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		dragging = true;
	}

	/** PNG data URL of the current view, e.g. for cart thumbnails. */
	export function snapshot() {
		return viewer?.snapshot() ?? null;
	}

	/** The loaded part as 3MF-style indexed mesh data (as uploaded, before rotation/scale). */
	export async function getMeshData() {
		if (!base) return null;
		const { geometryToMesh } = await import('$lib/storage/mesh');
		return geometryToMesh(base.geometry);
	}

	/**
	 * Close holes and fix bad faces in the loaded part, keeping its rotation,
	 * scale and camera. Resolves to what changed plus the repaired mesh (for
	 * saving), or null if there's nothing loaded.
	 */
	export async function repair() {
		const model = base;
		if (!model) return null;
		const [{ repairMesh }, { geometryToMesh }] = await Promise.all([
			import('$lib/viewer/repair'),
			import('$lib/storage/mesh')
		]);
		if (base !== model) return null;
		const { geometry, report } = repairMesh(model.geometry);
		model.geometry.dispose();
		base = { ...model, id: ++baseCounter, geometry, openEdges: report.openEdgesAfter, hull: undefined };
		return { report, mesh: geometryToMesh(geometry) };
	}

	/** Isometric PNG of the edited part on a transparent background. */
	export async function thumbnail(size = 512): Promise<Blob | null> {
		return viewer?.thumbnail(size) ?? null;
	}

	/** Binary STL of the part with the current rotation and scale baked in. */
	export async function exportModel(): Promise<Blob | null> {
		if (!base) return null;
		const { exportSTL } = await import('$lib/viewer/transform');
		return exportSTL(base.geometry, transform);
	}

	let rotated = $derived(axes.some((a) => transform.rotation[a] !== 0));
	let scaled = $derived(axes.some((a) => transform.scale[a] !== 1));

	const mm = (v: number) => v.toFixed(1);
	const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);
</script>

<div
	class="viewer"
	class:dragging
	style:height
	role="region"
	aria-label="3D model preview"
	ondragenter={onDragOver}
	ondragover={onDragOver}
	ondragleave={(e) => {
		if (!e.currentTarget.contains(e.relatedTarget as Node)) dragging = false;
	}}
	ondrop={onDrop}
>
	<div class="stage" bind:this={container}></div>

	{#if hud}
		<div class="hud-top">
			<div class="chip-group">
				<span class="chip">{bedLabel ?? `Bed: ${bed.x}×${bed.y}mm`}</span>
			</div>

			<div class="toolbar">
				<div class="segmented" role="group" aria-label="Camera view">
					{#each views as view (view.id)}
						<button
							class:active={activeView === view.id}
							onclick={() => setView(view.id)}
							disabled={!viewer}>{view.label}</button
						>
					{/each}
				</div>
				<div class="tools">
					{#if editable}
						<button
							class="tool"
							class:on={panel === 'rotate'}
							class:edited={rotated}
							title="Rotate model"
							aria-pressed={panel === 'rotate'}
							disabled={!analysis}
							onclick={() => togglePanel('rotate')}
						>
							<span class="material-symbols-outlined">3d_rotation</span>
						</button>
						<button
							class="tool"
							class:on={panel === 'scale'}
							class:edited={scaled}
							title="Scale model"
							aria-pressed={panel === 'scale'}
							disabled={!analysis}
							onclick={() => togglePanel('scale')}
						>
							<span class="material-symbols-outlined">open_in_full</span>
						</button>
						<span class="sep"></span>
					{/if}
					<button
						class="tool"
						class:on={autoRotate}
						title="Turntable"
						aria-pressed={autoRotate}
						onclick={() => (autoRotate = !autoRotate)}
					>
						<span class="material-symbols-outlined">360</span>
					</button>
					<button
						class="tool"
						class:on={showMeasure}
						title="Measure bounding box"
						aria-pressed={showMeasure}
						onclick={() => (showMeasure = !showMeasure)}
					>
						<span class="material-symbols-outlined">straighten</span>
					</button>
					<button
						class="tool"
						class:on={showOverhangs}
						class:warn={showOverhangs}
						title={`Highlight overhangs > ${overhangAngle}°`}
						aria-pressed={showOverhangs}
						onclick={() => (showOverhangs = !showOverhangs)}
					>
						<span class="material-symbols-outlined">change_history</span>
					</button>
					{#if allowDrop}
						<button class="tool" title="Open model file" onclick={() => fileInput?.click()}>
							<span class="material-symbols-outlined">upload_file</span>
						</button>
						<input
							bind:this={fileInput}
							type="file"
							accept={MODEL_ACCEPT}
							hidden
							onchange={(e) => takeFile(e.currentTarget.files)}
						/>
					{/if}
				</div>
			</div>
		</div>

		{#if editable && panel && analysis && unscaledSize}
			<div class="panel" role="dialog" aria-label={panel === 'rotate' ? 'Rotate model' : 'Scale model'}>
				{#if panel === 'rotate'}
					<div class="panel-head">
						<span class="panel-title"><span class="material-symbols-outlined">3d_rotation</span>Rotate</span>
						<button class="panel-icon" title="Reset rotation" onclick={resetRotation}>
							<span class="material-symbols-outlined">restart_alt</span>
						</button>
					</div>
					{#each axes as axis (axis)}
						<div class="axis-row">
							<span class="axis-label {axis}">{axis}</span>
							<button class="step-btn" title={`Rotate −90° around ${axis.toUpperCase()}`} onclick={() => setRotation(axis, transform.rotation[axis] - 90)}>−90</button>
							<label class="num-field">
								<input
									type="number"
									step="1"
									value={transform.rotation[axis]}
									onchange={(e) => setRotation(axis, num(e))}
									aria-label={`${axis.toUpperCase()} rotation in degrees`}
								/>
								<span>°</span>
							</label>
							<button class="step-btn" title={`Rotate +90° around ${axis.toUpperCase()}`} onclick={() => setRotation(axis, transform.rotation[axis] + 90)}>+90</button>
						</div>
					{/each}
					<button class="fit-btn" onclick={tryToFit} disabled={fitting}>
						{#if fitting}
							<span class="mini-spinner"></span>Searching orientations…
						{:else}
							<span class="material-symbols-outlined">fit_screen</span>Try to Fit Build Plate
						{/if}
					</button>
					{#if fitStatus === 'already'}
						<p class="fit-msg ok"><span class="material-symbols-outlined">check_circle</span>Already fits the {bed.x}×{bed.y}×{bed.z}mm volume.</p>
					{:else if fitStatus === 'rotated'}
						<p class="fit-msg ok"><span class="material-symbols-outlined">check_circle</span>Rotated to fit. Scale was not changed.</p>
					{:else if fitStatus === 'impossible'}
						<p class="fit-msg bad"><span class="material-symbols-outlined">error</span>No orientation fits at this scale. Scale it down or pick a larger machine.</p>
					{:else}
						<p class="fit-msg">Finds the closest rotation that fits the build volume. Never rescales.</p>
					{/if}
				{:else}
					<div class="panel-head">
						<span class="panel-title"><span class="material-symbols-outlined">open_in_full</span>Scale</span>
						<div class="panel-actions">
							<button
								class="panel-icon"
								class:on={scaleLocked}
								title={scaleLocked ? 'Proportions locked' : 'Proportions unlocked'}
								aria-pressed={scaleLocked}
								onclick={() => (scaleLocked = !scaleLocked)}
							>
								<span class="material-symbols-outlined">{scaleLocked ? 'link' : 'link_off'}</span>
							</button>
							<button class="panel-icon" title="Reset scale" onclick={resetScale}>
								<span class="material-symbols-outlined">restart_alt</span>
							</button>
						</div>
					</div>
					{#each axes as axis (axis)}
						<div class="axis-row">
							<span class="axis-label {axis}">{axis}</span>
							<label class="num-field">
								<input
									type="number"
									min="0.1"
									step="1"
									value={+(transform.scale[axis] * 100).toFixed(2)}
									onchange={(e) => setScalePercent(axis, num(e))}
									aria-label={`${axis.toUpperCase()} scale in percent`}
								/>
								<span>%</span>
							</label>
							<label class="num-field wide">
								<input
									type="number"
									min="0.01"
									step="0.1"
									value={+(unscaledSize[axis] * transform.scale[axis]).toFixed(2)}
									onchange={(e) => setSizeMm(axis, num(e))}
									aria-label={`${axis.toUpperCase()} size in millimetres`}
								/>
								<span>mm</span>
							</label>
						</div>
					{/each}
					<div class="unit-row">
						<button class="step-btn" title="Model was drawn in inches" onclick={() => multiplyScale(INCH_MM)}>in → mm</button>
						<button class="step-btn" title="Undo an inch conversion" onclick={() => multiplyScale(1 / INCH_MM)}>mm → in</button>
					</div>
				{/if}
			</div>
		{/if}

		{#if layers && analysis && status === 'ready'}
			<div class="layers">
				<span class="layers-label">Layer</span>
				<span class="layers-value">{shownLayer}</span>
				<input
					type="range"
					class="layer-slider"
					min="1"
					max={totalLayers}
					value={shownLayer}
					oninput={onLayerInput}
					aria-label="Layer preview"
				/>
				<span class="layers-total">/{totalLayers}</span>
				<span class="layers-height">{mm(shownLayer * layerHeight)}mm</span>
			</div>
		{/if}
	{/if}

	{#if status === 'loading'}
		<div class="center-card">
			<span class="spinner"></span>
			<span>Loading model…</span>
		</div>
	{:else if status === 'error'}
		<div class="center-card error">
			<span class="material-symbols-outlined">error</span>
			<span>{errorMessage}</span>
			{#if allowDrop}<small>Drop an STL, OBJ, 3MF or PLY file to preview it.</small>{/if}
		</div>
	{:else if webglFailed}
		<div class="center-card error">
			<span class="material-symbols-outlined">videocam_off</span>
			<span>3D preview needs WebGL, which isn't available in this browser.</span>
		</div>
	{:else if status === 'idle' && allowDrop}
		<div class="center-card">
			<span class="material-symbols-outlined">view_in_ar</span>
			<span>Drop an STL, OBJ, 3MF or PLY file to preview it</span>
		</div>
	{/if}

	{#if dragging}
		<div class="drop-overlay">
			<span class="material-symbols-outlined">file_download</span>
			<span>Release to preview</span>
		</div>
	{/if}

	{@render children?.()}

	{#if (hud && analysis) || (stats && info)}
		<div class="hud-bottom">
			{#if hud && analysis}
				<span class="chip file" title={analysis.name}>
					<span class="material-symbols-outlined">deployed_code</span>
					<span class="file-name">{analysis.name}</span>
					{#if base?.placeholder}<span class="tag">Sample</span>{/if}
				</span>
			{/if}
			{#if stats && info}
				<div class="stats">
					<div class="stat-group">
						<div class="stat">
							<span class="material-symbols-outlined accent">crop_free</span>
							<div>
								<span class="stat-label">Dimensions (X • Y • Z)</span>
								<span class="stat-value strong"
									>{mm(info.size.x)} × {mm(info.size.y)} × {mm(info.size.z)} mm</span
								>
							</div>
						</div>
						<span class="divider"></span>
						<div class="stat">
							<div>
								<span class="stat-label">Volume</span>
								<span class="stat-value">{info.volume.toFixed(1)} cm³</span>
							</div>
						</div>
						<span class="divider"></span>
						<div class="stat">
							<div>
								<span class="stat-label">Triangles</span>
								<span class="stat-value">{info.triangles.toLocaleString()}</span>
							</div>
						</div>
					</div>
					{#if info.fitsBed}
						<div class="fit ok">
							<span class="material-symbols-outlined">check_circle</span>
							<span>Fits {bed.x}×{bed.y}×{bed.z}mm envelope</span>
						</div>
					{:else}
						<div class="fit bad">
							<span class="material-symbols-outlined">error</span>
							<span>Exceeds {bed.x}×{bed.y}×{bed.z}mm envelope</span>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.viewer {
		position: relative;
		width: 100%;
		min-height: 320px;
		border-radius: var(--radius-lg);
		overflow: hidden;
		background: linear-gradient(
			to bottom,
			var(--surface-container-lowest),
			var(--surface-container-low) 50%,
			var(--surface-container)
		);
		box-shadow: var(--shadow-md);
		user-select: none;
		isolation: isolate;
	}

	.stage {
		position: absolute;
		inset: 0;
	}

	.stage :global(.mv-canvas) {
		display: block;
		width: 100%;
		height: 100%;
		cursor: grab;
		touch-action: none;
		outline: none;
	}

	.stage :global(.mv-canvas:active) {
		cursor: grabbing;
	}

	.stage :global(.mv-labels) {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.stage :global(.mv-label) {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		color: #64748b;
		white-space: nowrap;
	}

	.stage :global(.mv-label--measure) {
		padding: 1px 6px;
		border-radius: var(--radius-md);
		background: var(--primary);
		color: var(--on-primary);
		box-shadow: var(--shadow-sm);
	}

	/* ---------- HUD ---------- */
	.hud-top {
		position: absolute;
		inset: var(--space-md) var(--space-md) auto var(--space-md);
		z-index: 2;
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-sm);
		flex-wrap: wrap;
		pointer-events: none;
	}

	.hud-top > * {
		pointer-events: auto;
	}

	.chip-group {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		min-width: 0;
	}

	.chip,
	.toolbar {
		background: rgb(255 255 255 / 0.9);
		backdrop-filter: blur(12px);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: var(--space-xs) var(--space-sm);
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 16px;
		font-weight: 500;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--on-surface-variant);
	}

	.chip.file {
		max-width: 100%;
		text-transform: none;
		color: var(--on-surface);
	}

	.chip .material-symbols-outlined {
		font-size: 14px;
		color: var(--primary);
	}

	.file-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tag {
		padding: 0 0.25rem;
		border-radius: var(--radius-sm);
		background: var(--secondary-container);
		color: var(--on-secondary-container);
		font-size: 9px;
		font-weight: 600;
		text-transform: uppercase;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: 3px;
	}

	.segmented {
		display: flex;
		padding: 2px;
		border-radius: var(--radius-md);
		background: var(--surface-container);
	}

	.segmented button {
		padding: 2px var(--space-sm);
		border-radius: var(--radius-md);
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 16px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--on-surface-variant);
		transition:
			background-color 0.15s ease,
			color 0.15s ease;
	}

	.segmented button:hover {
		color: var(--on-surface);
	}

	.segmented button.active {
		background: var(--surface-container-lowest);
		color: var(--primary);
		box-shadow: var(--shadow-sm);
	}

	.tools {
		display: flex;
		gap: 2px;
	}

	.tool {
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-md);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--on-surface-variant);
		transition:
			background-color 0.15s ease,
			color 0.15s ease;
	}

	.tool .material-symbols-outlined {
		font-size: 18px;
	}

	.tool:hover {
		background: var(--surface-container);
		color: var(--on-surface);
	}

	.tool.on {
		background: var(--primary-tint);
		color: var(--primary);
	}

	.tool.warn {
		background: rgb(186 26 26 / 0.1);
		color: var(--error);
	}

	/* ---------- Layer slider ---------- */
	.layers {
		position: absolute;
		right: var(--space-md);
		top: 50%;
		transform: translateY(-50%);
		z-index: 2;
		width: 3.25rem;
		padding: var(--space-sm) 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-xs);
		background: rgb(255 255 255 / 0.9);
		backdrop-filter: blur(12px);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
		font-family: var(--font-mono);
	}

	.layers-label {
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--on-surface-variant);
	}

	.layers-value {
		font-size: 12px;
		font-weight: 700;
		color: var(--primary);
	}

	.layers-total,
	.layers-height {
		font-size: 9px;
		color: var(--on-surface-variant);
	}

	.layer-slider {
		writing-mode: vertical-lr;
		direction: rtl;
		width: 1.25rem;
		height: 10rem;
		margin: var(--space-xs) 0;
		accent-color: var(--primary);
		cursor: ns-resize;
	}

	/* ---------- Center states ---------- */
	.center-card {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		z-index: 2;
		max-width: min(22rem, calc(100% - 2rem));
		padding: var(--space-md) var(--space-lg);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-xs);
		text-align: center;
		background: rgb(255 255 255 / 0.92);
		backdrop-filter: blur(12px);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
		color: var(--on-surface);
		pointer-events: none;
	}

	.center-card .material-symbols-outlined {
		font-size: 28px;
		color: var(--primary);
	}

	.center-card small {
		font-size: 11px;
		color: var(--on-surface-variant);
	}

	.center-card.error .material-symbols-outlined {
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

	.drop-overlay {
		position: absolute;
		inset: var(--space-sm);
		z-index: 3;
		border: 2px dashed var(--primary);
		border-radius: var(--radius-lg);
		background: rgb(163 57 0 / 0.06);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-xs);
		font-weight: 600;
		color: var(--primary);
		pointer-events: none;
	}

	.drop-overlay .material-symbols-outlined {
		font-size: 36px;
	}

	/* ---------- Stats bar ---------- */
	.hud-bottom {
		position: absolute;
		inset: auto var(--space-md) var(--space-md) var(--space-md);
		z-index: 2;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-xs);
	}

	.stats {
		align-self: stretch;
		padding: var(--space-sm);
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		background: rgb(255 255 255 / 0.95);
		backdrop-filter: blur(12px);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
	}

	.stat-group {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-md);
	}

	.stat {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.stat > div {
		display: flex;
		flex-direction: column;
	}

	.stat .accent {
		font-size: 18px;
		color: var(--secondary);
	}

	.stat-label {
		font-family: var(--font-mono);
		font-size: 9px;
		line-height: 14px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--on-surface-variant);
	}

	.stat-value {
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 16px;
		font-weight: 500;
		letter-spacing: 0.02em;
		color: var(--on-surface);
	}

	.stat-value.strong {
		font-weight: 600;
	}

	.divider {
		display: none;
		width: 1px;
		height: 1.5rem;
		background: var(--surface-container-highest);
	}

	.fit {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: var(--space-xs) var(--space-sm);
		border-radius: var(--radius-md);
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 16px;
		font-weight: 500;
	}

	.fit .material-symbols-outlined {
		font-size: 16px;
	}

	.fit.ok {
		background: rgb(134 242 228 / 0.4);
		color: var(--on-secondary-container);
	}

	.fit.ok .material-symbols-outlined {
		color: var(--secondary);
	}

	.fit.bad {
		background: var(--error-container);
		color: var(--on-error-container);
	}

	@media (min-width: 640px) {
		.divider {
			display: block;
		}
	}

	/* ---------- Transform panel ---------- */
	.tool.edited::after {
		content: '';
		position: absolute;
		top: 3px;
		right: 3px;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--primary);
	}

	.tool {
		position: relative;
	}

	.tools .sep {
		width: 1px;
		margin: 4px 2px;
		background: var(--surface-container-highest);
	}

	.panel {
		position: absolute;
		top: 3.5rem;
		left: var(--space-md);
		z-index: 3;
		width: 15.5rem;
		max-width: calc(100% - 2 * var(--space-md) - 4rem);
		padding: var(--space-sm);
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		background: rgb(255 255 255 / 0.95);
		backdrop-filter: blur(12px);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
	}

	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-bottom: 0.25rem;
		border-bottom: 1px solid var(--surface-container-highest);
	}

	.panel-title {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--on-surface);
	}

	.panel-title .material-symbols-outlined {
		font-size: 16px;
		color: var(--primary);
	}

	.panel-actions {
		display: flex;
		gap: 2px;
	}

	.panel-icon {
		width: 1.5rem;
		height: 1.5rem;
		border-radius: var(--radius-md);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--on-surface-variant);
	}

	.panel-icon .material-symbols-outlined {
		font-size: 16px;
	}

	.panel-icon:hover {
		background: var(--surface-container);
		color: var(--on-surface);
	}

	.panel-icon.on {
		background: var(--primary-tint);
		color: var(--primary);
	}

	.axis-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.axis-label {
		width: 1.25rem;
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 700;
		text-align: center;
		text-transform: uppercase;
	}

	.axis-label.x {
		color: #dc2626;
	}

	.axis-label.y {
		color: #16a34a;
	}

	.axis-label.z {
		color: #2563eb;
	}

	.num-field {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 0 0.375rem;
		border: 1px solid var(--surface-container-highest);
		border-radius: var(--radius-md);
		background: var(--surface-container-lowest);
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--on-surface-variant);
	}

	.num-field:focus-within {
		border-color: var(--primary);
	}

	.num-field.wide {
		flex: 1.2;
	}

	.num-field input {
		width: 100%;
		min-width: 0;
		padding: 0.25rem 0;
		border: none;
		outline: none;
		background: none;
		font: inherit;
		color: var(--on-surface);
		text-align: right;
		-moz-appearance: textfield;
		appearance: textfield;
	}

	.num-field input::-webkit-inner-spin-button,
	.num-field input::-webkit-outer-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}

	.step-btn {
		flex-shrink: 0;
		padding: 0.25rem 0.375rem;
		border-radius: var(--radius-md);
		background: var(--surface-container);
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		color: var(--on-surface-variant);
		transition:
			background-color 0.15s ease,
			color 0.15s ease;
	}

	.step-btn:hover {
		background: var(--surface-container-high);
		color: var(--on-surface);
	}

	.unit-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.25rem;
	}

	.fit-btn {
		margin-top: 0.25rem;
		padding: 0.375rem var(--space-sm);
		border-radius: var(--radius-md);
		background: var(--primary);
		color: var(--on-primary);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		transition: background-color 0.15s ease;
	}

	.fit-btn:hover:not(:disabled) {
		background: var(--primary-container);
	}

	.fit-btn:disabled {
		opacity: 0.8;
		cursor: progress;
	}

	.fit-btn .material-symbols-outlined {
		font-size: 16px;
	}

	.mini-spinner {
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 50%;
		border: 2px solid rgb(255 255 255 / 0.35);
		border-top-color: var(--on-primary);
		animation: spin 0.8s linear infinite;
	}

	.fit-msg {
		display: flex;
		align-items: flex-start;
		gap: 0.25rem;
		font-size: 11px;
		line-height: 15px;
		color: var(--on-surface-variant);
	}

	.fit-msg .material-symbols-outlined {
		flex-shrink: 0;
		font-size: 14px;
	}

	.fit-msg.ok .material-symbols-outlined {
		color: var(--secondary);
	}

	.fit-msg.bad {
		color: var(--on-error-container);
	}

	.fit-msg.bad .material-symbols-outlined {
		color: var(--error);
	}
</style>
