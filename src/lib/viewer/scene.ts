import {
	ACESFilmicToneMapping,
	BackSide,
	Box3,
	BoxGeometry,
	BufferGeometry,
	CanvasTexture,
	Color,
	DirectionalLight,
	DoubleSide,
	EdgesGeometry,
	Float32BufferAttribute,
	Group,
	HemisphereLight,
	Line,
	LineBasicMaterial,
	LineLoop,
	LineDashedMaterial,
	LineSegments,
	Mesh,
	MeshBasicMaterial,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
	PCFShadowMap,
	PerspectiveCamera,
	Plane,
	PlaneGeometry,
	PMREMGenerator,
	Raycaster,
	Scene,
	Sphere,
	SRGBColorSpace,
	Vector2,
	Vector3,
	WebGLRenderer
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BedSize } from './analysis';
import { overhangMask } from './analysis';
import { MeasurePicker, type CircleFit, type MeasureMode } from './measure';

export type ViewPreset = 'iso' | 'top' | 'front' | 'side' | 'bottom';

/** What the measure tool reports after each click. Lengths in mm; deltas along printer X / Y / Z. */
export type MeasureResult =
	| { kind: 'empty'; mode: MeasureMode; picks: number }
	| { kind: 'miss'; mode: MeasureMode; message: string }
	| { kind: 'distance'; mode: MeasureMode; distance: number; delta: { x: number; y: number; z: number } }
	| { kind: 'circle'; mode: MeasureMode; diameter: number; radius: number; closed: boolean };

export type ViewerPalette = {
	accent: string;
	overhang: string;
	plate: string;
	gridMinor: string;
	gridMajor: string;
	frame: string;
};

const VIEW_DIRECTIONS: Record<ViewPreset, Vector3> = {
	iso: new Vector3(0.85, 0.7, 1.15).normalize(),
	top: new Vector3(0, 1, 0.001).normalize(),
	front: new Vector3(0, 0.12, 1).normalize(),
	side: new Vector3(1, 0.12, 0).normalize(),
	bottom: new Vector3(0.001, -1, 0.35).normalize()
};

const CREASE_ANGLE = (35 * Math.PI) / 180;
const TWEEN_MS = 650;
/** Bed opacity while the camera is below the plate. */
const UNDER_BED_OPACITY = { base: 0.18, surface: 0.32 };

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function label(text: string, className = 'mv-label') {
	const el = document.createElement('div');
	el.className = className;
	el.textContent = text;
	return new CSS2DObject(el);
}

/** Screen-sized dot marking a picked (or hovered) point. */
function pin(at: Vector3, ghost = false) {
	const el = document.createElement('div');
	el.className = ghost ? 'mv-pin mv-pin--ghost' : 'mv-pin';
	const obj = new CSS2DObject(el);
	obj.position.copy(at);
	return obj;
}

function disposeTree(root: Group) {
	root.traverse((o) => {
		if (o instanceof Mesh || o instanceof Line) {
			o.geometry.dispose();
			const mats = Array.isArray(o.material) ? o.material : [o.material];
			for (const m of mats) {
				(m as MeshStandardMaterial).map?.dispose();
				m.dispose();
			}
		}
		if (o instanceof CSS2DObject) o.element.remove();
	});
	root.clear();
}

/**
 * Owns the three.js scene for the model preview: build plate, lighting,
 * camera controls and the displayed part. Framework-agnostic so the Svelte
 * component only has to forward props.
 */
export class ViewerScene {
	readonly renderer: WebGLRenderer;
	private labels: CSS2DRenderer;
	private scene = new Scene();
	private camera = new PerspectiveCamera(35, 1, 1, 10000);
	private controls: OrbitControls;
	private pmrem: PMREMGenerator;
	private keyLight = new DirectionalLight(0xffffff, 1.6);

	private bedGroup = new Group();
	private bedBase: MeshStandardMaterial | null = null;
	private bedSurface: MeshStandardMaterial | null = null;
	private underBed = false;
	private measureGroup = new Group();
	private cutGroup = new Group();
	/** Picks and results of the point / vertex / circle measure tool. */
	private toolGroup = new Group();
	/** Live preview under the cursor while the tool is on. */
	private hoverGroup = new Group();
	private picker: MeasurePicker | null = null;
	private tool: { mode: MeasureMode; onResult: (result: MeasureResult) => void } | null = null;
	private picks: Vector3[] = [];
	private pointerDown: { x: number; y: number } | null = null;
	private hoverFrame = 0;
	private raycaster = new Raycaster();

	private material: MeshPhysicalMaterial;
	private capMaterial: MeshBasicMaterial;
	private clipPlane = new Plane(new Vector3(0, -1, 0), Infinity);
	private model: Mesh | null = null;
	private cap: Mesh | null = null;
	private modelBox = new Box3();

	private bed: BedSize = { x: 250, y: 250, z: 250 };
	private color = new Color('#f59e0b');
	private overhangs = { enabled: false, angle: 45 };
	private palette: ViewerPalette;

	private tween: {
		start: number;
		fromPos: Vector3;
		toPos: Vector3;
		fromTarget: Vector3;
		toTarget: Vector3;
	} | null = null;
	private frame = 0;
	private running = false;
	private resizeObserver: ResizeObserver;
	private visibilityObserver: IntersectionObserver;

	constructor(
		private container: HTMLElement,
		palette: ViewerPalette
	) {
		this.palette = palette;

		this.renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.outputColorSpace = SRGBColorSpace;
		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.05;
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = PCFShadowMap;
		this.renderer.localClippingEnabled = true;
		this.renderer.domElement.classList.add('mv-canvas');
		container.appendChild(this.renderer.domElement);

		this.labels = new CSS2DRenderer();
		this.labels.domElement.classList.add('mv-labels');
		container.appendChild(this.labels.domElement);

		this.pmrem = new PMREMGenerator(this.renderer);
		this.scene.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		this.scene.environmentIntensity = 0.55;

		this.scene.add(new HemisphereLight(0xffffff, 0xc7d2fe, 0.6));
		this.keyLight.castShadow = true;
		this.keyLight.shadow.mapSize.set(2048, 2048);
		this.keyLight.shadow.bias = -0.0004;
		this.keyLight.shadow.normalBias = 0.6;
		this.keyLight.shadow.radius = 6;
		this.scene.add(this.keyLight, this.keyLight.target);
		const rim = new DirectionalLight(0xdbeafe, 0.5);
		rim.position.set(-300, 200, -300);
		this.scene.add(rim);

		this.material = new MeshPhysicalMaterial({
			color: this.color,
			roughness: 0.48,
			metalness: 0,
			clearcoat: 0.25,
			clearcoatRoughness: 0.5,
			clippingPlanes: [this.clipPlane]
		});
		this.capMaterial = new MeshBasicMaterial({
			color: palette.accent,
			side: BackSide,
			clippingPlanes: [this.clipPlane]
		});

		this.scene.add(this.bedGroup, this.measureGroup, this.cutGroup, this.toolGroup, this.hoverGroup);
		this.measureGroup.visible = false;
		this.cutGroup.visible = false;

		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;
		this.controls.maxPolarAngle = Math.PI;
		this.controls.minDistance = 15;
		this.controls.autoRotateSpeed = 1.2;
		this.controls.addEventListener('start', () => (this.tween = null));

		const canvas = this.renderer.domElement;
		canvas.addEventListener('pointerdown', this.onPointerDown);
		canvas.addEventListener('pointerup', this.onPointerUp);
		canvas.addEventListener('pointermove', this.onPointerMove);
		canvas.addEventListener('pointerleave', this.onPointerLeave);

		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(container);
		this.visibilityObserver = new IntersectionObserver(([entry]) =>
			entry.isIntersecting ? this.start() : this.stop()
		);
		this.visibilityObserver.observe(container);

		this.resize();
		this.buildBed();
		this.view('iso', false);
	}

	// ---------- Bed ----------

	setBed(bed: BedSize) {
		if (bed.x === this.bed.x && bed.y === this.bed.y && bed.z === this.bed.z) return;
		this.bed = { ...bed };
		this.buildBed();
		this.controls.maxDistance = Math.max(bed.x, bed.y, bed.z) * 5;
	}

	private gridTexture() {
		const { x, y } = this.bed;
		const scale = Math.min(6, 2048 / Math.max(x, y));
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(x * scale);
		canvas.height = Math.round(y * scale);
		const ctx = canvas.getContext('2d')!;
		ctx.fillStyle = this.palette.plate;
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		const lines = (step: number, color: string, width: number) => {
			ctx.strokeStyle = color;
			ctx.lineWidth = width;
			ctx.beginPath();
			for (let mm = 0; mm <= x; mm += step) {
				ctx.moveTo(mm * scale, 0);
				ctx.lineTo(mm * scale, canvas.height);
			}
			for (let mm = 0; mm <= y; mm += step) {
				ctx.moveTo(0, mm * scale);
				ctx.lineTo(canvas.width, mm * scale);
			}
			ctx.stroke();
		};
		lines(10, this.palette.gridMinor, 1);
		lines(50, this.palette.gridMajor, 2);

		ctx.strokeStyle = this.palette.frame;
		ctx.lineWidth = 4;
		ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);

		// Centre crosshair
		const cx = canvas.width / 2;
		const cy = canvas.height / 2;
		const arm = 8 * scale;
		ctx.strokeStyle = this.palette.accent;
		ctx.lineWidth = Math.max(2, scale * 0.6);
		ctx.beginPath();
		ctx.moveTo(cx - arm, cy);
		ctx.lineTo(cx + arm, cy);
		ctx.moveTo(cx, cy - arm);
		ctx.lineTo(cx, cy + arm);
		ctx.stroke();
		ctx.fillStyle = this.palette.accent;
		ctx.beginPath();
		ctx.arc(cx, cy, scale * 1.4, 0, Math.PI * 2);
		ctx.fill();

		const texture = new CanvasTexture(canvas);
		texture.colorSpace = SRGBColorSpace;
		texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
		return texture;
	}

	private buildBed() {
		disposeTree(this.bedGroup);
		const { x, y, z } = this.bed;

		this.bedBase = new MeshStandardMaterial({ color: '#cbd5e1', metalness: 0.55, roughness: 0.42 });
		const base = new Mesh(new BoxGeometry(x + 10, 6, y + 10), this.bedBase);
		base.position.y = -3.2;
		base.receiveShadow = true;

		this.bedSurface = new MeshStandardMaterial({
			map: this.gridTexture(),
			roughness: 0.85,
			metalness: 0,
			side: DoubleSide
		});
		const surface = new Mesh(new PlaneGeometry(x, y), this.bedSurface);
		surface.rotation.x = -Math.PI / 2;
		surface.position.y = -0.15;
		surface.receiveShadow = true;

		const volume = new LineSegments(
			new EdgesGeometry(new BoxGeometry(x, z, y)),
			new LineDashedMaterial({
				color: this.palette.frame,
				dashSize: 4,
				gapSize: 4,
				transparent: true,
				opacity: 0.45
			})
		);
		volume.position.y = z / 2;
		volume.computeLineDistances();

		const origin = label('(0,0)');
		origin.position.set(-x / 2 - 4, 0, y / 2 + 6);
		const xLabel = label(`X: ${x}mm`);
		xLabel.position.set(0, 0, y / 2 + 14);
		const yLabel = label(`Y: ${y}mm`);
		yLabel.position.set(x / 2 + 14, 0, 0);
		const zLabel = label(`Z: ${z}mm`);
		zLabel.position.set(-x / 2, z + 6, -y / 2);

		this.bedGroup.add(base, surface, volume, origin, xLabel, yLabel, zLabel);
		this.underBed = false;
		this.updateUnderBed();

		const reach = Math.max(x, y) * 0.75;
		this.keyLight.position.set(x * 0.35, Math.max(z, 200) * 1.6, y * 0.55);
		const cam = this.keyLight.shadow.camera;
		cam.left = cam.bottom = -reach;
		cam.right = cam.top = reach;
		cam.near = 1;
		cam.far = Math.max(z, 200) * 4;
		cam.updateProjectionMatrix();
	}

	/** Fade the plate when looking from underneath so the part stays visible. */
	private updateUnderBed() {
		const under = this.camera.position.y < this.bedGroup.position.y - 0.5;
		if (under === this.underBed || !this.bedBase || !this.bedSurface) return;
		this.underBed = under;
		for (const [material, opacity] of [
			[this.bedBase, UNDER_BED_OPACITY.base],
			[this.bedSurface, UNDER_BED_OPACITY.surface]
		] as const) {
			material.transparent = under;
			material.opacity = under ? opacity : 1;
			material.depthWrite = !under;
			material.needsUpdate = true;
		}
	}

	// ---------- Model ----------

	/**
	 * Show a part. Geometry must be Z-up in mm; it is re-oriented and dropped
	 * onto the bed. Returns the placed copy. `refit` re-frames the camera —
	 * pass false when the same part was just edited.
	 */
	setGeometry(source: BufferGeometry | null, refit = true): BufferGeometry | null {
		// Picks refer to the old mesh; an edit (rotate / scale) invalidates them.
		this.picker = null;
		this.clearMeasureTool();
		if (this.model) {
			this.model.geometry.dispose();
			this.scene.remove(this.model, this.cap!);
			this.model = this.cap = null;
		}
		if (!source) {
			this.modelBox.makeEmpty();
			this.buildMeasure();
			return null;
		}

		const placed = source.clone();
		placed.rotateX(-Math.PI / 2);
		placed.computeBoundingBox();
		const box = placed.boundingBox!;
		const center = box.getCenter(new Vector3());
		placed.translate(-center.x, -box.min.y, -center.z);
		placed.computeBoundingBox();
		this.modelBox.copy(placed.boundingBox!);

		const display = toCreasedNormals(placed, CREASE_ANGLE);
		this.model = new Mesh(display, this.material);
		this.model.castShadow = true;
		this.model.receiveShadow = true;
		this.cap = new Mesh(display, this.capMaterial);
		this.cap.visible = this.cutGroup.visible;
		this.scene.add(this.model, this.cap);

		this.applyColors();
		this.buildMeasure();
		this.buildCutIndicator();
		if (refit) this.view('iso', false);
		return placed;
	}

	setColor(color: string) {
		this.color.set(color);
		this.applyColors();
	}

	setOverhangs(enabled: boolean, angle: number) {
		this.overhangs = { enabled, angle };
		this.applyColors();
	}

	/** Overhang area (cm²) of the displayed part at a given threshold, or null with no part. */
	overhangArea(angle: number): number | null {
		return this.model ? overhangMask(this.model.geometry, angle).area : null;
	}

	private applyColors() {
		if (!this.model) return;
		const geometry = this.model.geometry;
		const useVertexColors = this.overhangs.enabled;

		if (useVertexColors) {
			const { mask } = overhangMask(geometry, this.overhangs.angle);
			const warn = new Color(this.palette.overhang);
			const colors = new Float32Array(geometry.getAttribute('position').count * 3);
			for (let face = 0; face < mask.length; face++) {
				const c = mask[face] ? warn : this.color;
				for (let v = 0; v < 3; v++) c.toArray(colors, (face * 3 + v) * 3);
			}
			geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
			this.material.color.set(0xffffff);
		} else {
			geometry.deleteAttribute('color');
			this.material.color.copy(this.color);
		}
		if (this.material.vertexColors !== useVertexColors) {
			this.material.vertexColors = useVertexColors;
			this.material.needsUpdate = true;
		}
	}

	// ---------- Measure overlay ----------

	setMeasure(enabled: boolean) {
		this.measureGroup.visible = enabled;
		for (const child of this.measureGroup.children) child.visible = enabled;
	}

	private buildMeasure() {
		disposeTree(this.measureGroup);
		if (this.modelBox.isEmpty()) return;

		const { min, max } = this.modelBox;
		const size = this.modelBox.getSize(new Vector3());
		const box = new LineSegments(
			new EdgesGeometry(new BoxGeometry(size.x, size.y, size.z)),
			new LineBasicMaterial({ color: this.palette.accent, transparent: true, opacity: 0.7 })
		);
		box.position.copy(this.modelBox.getCenter(new Vector3()));

		const fmt = (v: number) => `${v.toFixed(1)} mm`;
		const lx = label(fmt(size.x), 'mv-label mv-label--measure');
		lx.position.set((min.x + max.x) / 2, min.y, max.z);
		const ly = label(fmt(size.z), 'mv-label mv-label--measure');
		ly.position.set(max.x, min.y, (min.z + max.z) / 2);
		const lz = label(fmt(size.y), 'mv-label mv-label--measure');
		lz.position.set(max.x, (min.y + max.y) / 2, max.z);

		this.measureGroup.add(box, lx, ly, lz);
		this.setMeasure(this.measureGroup.visible);
	}

	// ---------- Measure tool (points, vertices, circles) ----------

	/** Turn the click-to-measure tool on (`mode`) or off (`null`). Changing mode clears the picks. */
	setMeasureTool(mode: MeasureMode | null, onResult: (result: MeasureResult) => void) {
		const changed = this.tool?.mode !== mode;
		this.tool = mode ? { mode, onResult } : null;
		this.renderer.domElement.classList.toggle('mv-canvas--pick', !!mode);
		if (changed) this.clearMeasureTool();
	}

	/** Forget the picks and remove the drawn measurement. */
	clearMeasureTool() {
		this.picks = [];
		disposeTree(this.toolGroup);
		disposeTree(this.hoverGroup);
		this.tool?.onResult({ kind: 'empty', mode: this.tool.mode, picks: 0 });
	}

	private onPointerDown = (e: PointerEvent) => {
		this.pointerDown = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
	};

	private onPointerUp = (e: PointerEvent) => {
		const down = this.pointerDown;
		this.pointerDown = null;
		// A drag orbits the camera; only a click (barely moved) picks.
		if (!this.tool || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
		this.pick(e);
	};

	private onPointerMove = (e: PointerEvent) => {
		if (!this.tool || e.buttons || e.pointerType === 'touch') return;
		cancelAnimationFrame(this.hoverFrame);
		this.hoverFrame = requestAnimationFrame(() => this.hover(e));
	};

	private onPointerLeave = () => {
		cancelAnimationFrame(this.hoverFrame);
		disposeTree(this.hoverGroup);
	};

	/** Where a pointer event lands on the part, snapped for the current mode. */
	private target(e: PointerEvent): { point: Vector3; circle?: CircleFit } | 'no-circle' | null {
		if (!this.model || !this.tool) return null;
		const rect = this.renderer.domElement.getBoundingClientRect();
		const ndc = new Vector2(
			((e.clientX - rect.left) / rect.width) * 2 - 1,
			-((e.clientY - rect.top) / rect.height) * 2 + 1
		);
		this.raycaster.setFromCamera(ndc, this.camera);
		this.picker ??= new MeasurePicker(this.model.geometry);
		const hit = this.picker.raycast(this.raycaster.ray, this.clipPlane.constant);
		if (!hit) return null;
		if (this.tool.mode === 'point') return { point: hit.point };
		if (this.tool.mode === 'vertex') return { point: this.picker.snapToVertex(hit.point, hit.face) };

		// Circle: look for a rim within ~12 px of the cursor.
		const fov = (this.camera.fov * Math.PI) / 180;
		const mmPerPx = (2 * hit.point.distanceTo(this.camera.position) * Math.tan(fov / 2)) / rect.height;
		const circle = this.picker.findCircle(hit.point, mmPerPx * 12);
		return circle ? { point: circle.center, circle } : 'no-circle';
	}

	private pick(e: PointerEvent) {
		const tool = this.tool!;
		const t = this.target(e);
		disposeTree(this.hoverGroup);
		if (t === 'no-circle') {
			tool.onResult({ kind: 'miss', mode: tool.mode, message: 'No round edge there. Click on or right beside a hole or rim.' });
			return;
		}
		if (!t) return;

		if (t.circle) {
			this.picks = [];
			disposeTree(this.toolGroup);
			this.drawCircle(this.toolGroup, t.circle, 1);
			tool.onResult({
				kind: 'circle',
				mode: tool.mode,
				diameter: t.circle.radius * 2,
				radius: t.circle.radius,
				closed: t.circle.closed
			});
			return;
		}

		// A third click starts a new measurement.
		if (this.picks.length >= 2) {
			this.picks = [];
			disposeTree(this.toolGroup);
		}
		this.picks.push(t.point);
		this.toolGroup.add(pin(t.point));
		if (this.picks.length === 1) {
			tool.onResult({ kind: 'empty', mode: tool.mode, picks: 1 });
			return;
		}
		const [a, b] = this.picks;
		this.drawSegment(this.toolGroup, a, b, 1);
		tool.onResult({
			kind: 'distance',
			mode: tool.mode,
			distance: a.distanceTo(b),
			// The scene is Y-up: printer X = x, Y = −z, Z = y.
			delta: { x: Math.abs(b.x - a.x), y: Math.abs(b.z - a.z), z: Math.abs(b.y - a.y) }
		});
	}

	private hover(e: PointerEvent) {
		disposeTree(this.hoverGroup);
		const t = this.target(e);
		if (!t || t === 'no-circle') return;
		if (t.circle) {
			this.drawCircle(this.hoverGroup, t.circle, 0.45);
			return;
		}
		this.hoverGroup.add(pin(t.point, true));
		if (this.picks.length === 1) this.drawSegment(this.hoverGroup, this.picks[0], t.point, 0.5);
	}

	/** Lines drawn over the part so a measurement stays visible from any angle. */
	private overlayMaterial(opacity: number) {
		return new LineBasicMaterial({ color: this.palette.accent, transparent: true, opacity, depthTest: false });
	}

	private drawSegment(group: Group, a: Vector3, b: Vector3, opacity: number) {
		const line = new Line(new BufferGeometry().setFromPoints([a, b]), this.overlayMaterial(opacity));
		line.renderOrder = 10;
		const tag = label(`${a.distanceTo(b).toFixed(2)} mm`, 'mv-label mv-label--measure');
		tag.position.lerpVectors(a, b, 0.5);
		group.add(line, tag);
	}

	private drawCircle(group: Group, c: CircleFit, opacity: number) {
		const ex = new Vector3(1, 0, 0);
		if (Math.abs(ex.dot(c.normal)) > 0.9) ex.set(0, 1, 0);
		ex.addScaledVector(c.normal, -ex.dot(c.normal)).normalize();
		const ey = new Vector3().crossVectors(c.normal, ex);
		const ring: Vector3[] = [];
		for (let i = 0; i < 96; i++) {
			const t = (i / 96) * Math.PI * 2;
			ring.push(c.center.clone().addScaledVector(ex, Math.cos(t) * c.radius).addScaledVector(ey, Math.sin(t) * c.radius));
		}
		const loop = new LineLoop(new BufferGeometry().setFromPoints(ring), this.overlayMaterial(opacity));
		loop.renderOrder = 10;
		const across = new Line(new BufferGeometry().setFromPoints([ring[0], ring[48]]), this.overlayMaterial(opacity * 0.6));
		across.renderOrder = 10;
		const tag = label(`Ø ${(c.radius * 2).toFixed(2)} mm`, 'mv-label mv-label--measure');
		tag.position.copy(c.center);
		group.add(loop, across, tag);
	}

	// ---------- Layer cut ----------

	/** Clip the part at a height (mm). `null` shows the whole part. */
	setCut(height: number | null) {
		const active = height !== null && !this.modelBox.isEmpty() && height < this.modelBox.max.y;
		this.clipPlane.constant = active ? height! : Infinity;
		this.cutGroup.visible = active;
		if (this.cap) this.cap.visible = active;
		if (active) this.cutGroup.position.y = height!;
	}

	private buildCutIndicator() {
		disposeTree(this.cutGroup);
		const size = this.modelBox.getSize(new Vector3());
		const w = size.x * 1.25 + 10;
		const d = size.z * 1.25 + 10;
		const plane = new Mesh(
			new PlaneGeometry(w, d),
			new MeshBasicMaterial({
				color: this.palette.accent,
				transparent: true,
				opacity: 0.08,
				side: DoubleSide,
				depthWrite: false
			})
		);
		plane.rotation.x = -Math.PI / 2;
		const outline = new LineSegments(
			new EdgesGeometry(new PlaneGeometry(w, d)),
			new LineBasicMaterial({ color: this.palette.accent, transparent: true, opacity: 0.6 })
		);
		outline.rotation.x = -Math.PI / 2;
		this.cutGroup.add(plane, outline);
	}

	// ---------- Camera ----------

	setAutoRotate(enabled: boolean) {
		this.controls.autoRotate = enabled;
	}

	view(preset: ViewPreset, animate = true) {
		const focus = this.modelBox.isEmpty()
			? new Box3(
					new Vector3(-this.bed.x / 2, 0, -this.bed.y / 2),
					new Vector3(this.bed.x / 2, this.bed.z * 0.3, this.bed.y / 2)
				)
			: this.modelBox;
		const target = focus.getCenter(new Vector3());
		const radius = Math.max(focus.getSize(new Vector3()).length() / 2, 45);
		const fov = (this.camera.fov * Math.PI) / 180;
		const fitFov = this.camera.aspect < 1 ? 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect) : fov;
		const distance = (radius / Math.sin(fitFov / 2)) * 1.08;
		const position = VIEW_DIRECTIONS[preset].clone().multiplyScalar(distance).add(target);

		if (!animate) {
			this.tween = null;
			this.camera.position.copy(position);
			this.controls.target.copy(target);
			this.controls.update();
			return;
		}
		this.tween = {
			start: performance.now(),
			fromPos: this.camera.position.clone(),
			toPos: position,
			fromTarget: this.controls.target.clone(),
			toTarget: target
		};
	}

	/**
	 * Isometric render of just the part (no bed, measurements or cut) on a
	 * transparent background, cropped square. Independent of where the user
	 * has orbited the camera. Resolves to a PNG blob, or null with no part.
	 */
	thumbnail(size = 512): Promise<Blob | null> {
		if (!this.model) return Promise.resolve(null);
		const canvas = this.renderer.domElement;
		const { width: w, height: h } = canvas;
		if (!w || !h) return Promise.resolve(null);
		const side = Math.min(w, h);

		// Frame the part's bounding sphere inside the centred square.
		const camera = this.camera.clone();
		const sphere = this.modelBox.getBoundingSphere(new Sphere());
		const vFov = (camera.fov * Math.PI) / 180;
		const squareFov = 2 * Math.atan((Math.tan(vFov / 2) * side) / h);
		const distance = (sphere.radius / Math.sin(squareFov / 2)) * 1.04;
		camera.aspect = w / h;
		camera.position.copy(VIEW_DIRECTIONS.iso).multiplyScalar(distance).add(sphere.center);
		camera.near = Math.max(0.1, distance - sphere.radius * 2);
		camera.far = distance + sphere.radius * 2;
		camera.lookAt(sphere.center);
		camera.updateProjectionMatrix();

		const hidden = [this.bedGroup, this.measureGroup, this.cutGroup, this.toolGroup, this.hoverGroup, this.cap].filter(
			(o): o is NonNullable<typeof o> => !!o && o.visible
		);
		const clip = this.clipPlane.constant;
		const overhangs = this.overhangs;
		for (const o of hidden) o.visible = false;
		this.clipPlane.constant = Infinity;
		if (overhangs.enabled) this.setOverhangs(false, overhangs.angle);

		this.renderer.render(this.scene, camera);
		const out = document.createElement('canvas');
		out.width = out.height = size;
		out.getContext('2d')!.drawImage(canvas, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);

		for (const o of hidden) o.visible = true;
		this.clipPlane.constant = clip;
		if (overhangs.enabled) this.setOverhangs(true, overhangs.angle);
		this.render();

		return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
	}

	/** Current frame as a PNG data URL — handy for thumbnails on order/cart screens. */
	snapshot(): string {
		this.render();
		return this.renderer.domElement.toDataURL('image/png');
	}

	// ---------- Loop ----------

	private resize() {
		const { clientWidth: w, clientHeight: h } = this.container;
		if (!w || !h) return;
		this.renderer.setSize(w, h, false);
		this.labels.setSize(w, h);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		if (!this.running) this.render();
	}

	private render() {
		if (this.tween) {
			const t = Math.min(1, (performance.now() - this.tween.start) / TWEEN_MS);
			const k = easeInOutCubic(t);
			this.camera.position.lerpVectors(this.tween.fromPos, this.tween.toPos, k);
			this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, k);
			if (t === 1) this.tween = null;
		}
		this.controls.update();
		this.updateUnderBed();
		this.renderer.render(this.scene, this.camera);
		this.labels.render(this.scene, this.camera);
	}

	private start() {
		if (this.running) return;
		this.running = true;
		const tick = () => {
			if (!this.running) return;
			this.render();
			this.frame = requestAnimationFrame(tick);
		};
		tick();
	}

	private stop() {
		this.running = false;
		cancelAnimationFrame(this.frame);
	}

	dispose() {
		this.stop();
		cancelAnimationFrame(this.hoverFrame);
		this.tool = null;
		const canvas = this.renderer.domElement;
		canvas.removeEventListener('pointerdown', this.onPointerDown);
		canvas.removeEventListener('pointerup', this.onPointerUp);
		canvas.removeEventListener('pointermove', this.onPointerMove);
		canvas.removeEventListener('pointerleave', this.onPointerLeave);
		this.resizeObserver.disconnect();
		this.visibilityObserver.disconnect();
		this.setGeometry(null);
		disposeTree(this.bedGroup);
		disposeTree(this.measureGroup);
		disposeTree(this.cutGroup);
		disposeTree(this.toolGroup);
		disposeTree(this.hoverGroup);
		this.material.dispose();
		this.capMaterial.dispose();
		this.scene.environment?.dispose();
		this.pmrem.dispose();
		this.controls.dispose();
		this.renderer.dispose();
		this.renderer.domElement.remove();
		this.labels.domElement.remove();
	}
}
