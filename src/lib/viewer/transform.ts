import { BufferGeometry, Euler, Matrix4, Mesh, Quaternion, Vector3 } from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

type Axes = { x: number; y: number; z: number };

/**
 * Edits applied to the loaded part, in printer coordinates (Z up, mm).
 * Rotation is applied first, then scale along the printer axes.
 */
export type ModelTransform = {
	/** Degrees, XYZ order. */
	rotation: Axes;
	/** Factors (1 = 100%). */
	scale: Axes;
};

export const MIN_SCALE = 0.001;
export const MAX_SCALE = 100;

export function identityTransform(): ModelTransform {
	return { rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
}

export function isIdentity(t: ModelTransform) {
	const { rotation: r, scale: s } = t;
	return r.x === 0 && r.y === 0 && r.z === 0 && s.x === 1 && s.y === 1 && s.z === 1;
}

const DEG = Math.PI / 180;

export function rotationQuaternion(rotation: Axes) {
	return new Quaternion().setFromEuler(new Euler(rotation.x * DEG, rotation.y * DEG, rotation.z * DEG, 'XYZ'));
}

/** Euler degrees from a quaternion, rounded to `decimals` (pass Infinity for exact). */
export function rotationFromQuaternion(q: Quaternion, decimals = 2): Axes {
	const e = new Euler().setFromQuaternion(q, 'XYZ');
	const f = 10 ** decimals;
	const clean = (rad: number) => {
		const deg = rad / DEG;
		const rounded = Number.isFinite(f) ? Math.round(deg * f) / f : deg;
		return Object.is(rounded, -0) ? 0 : rounded;
	};
	return { x: clean(e.x), y: clean(e.y), z: clean(e.z) };
}

/** Wrap an angle into (-180, 180]. */
export function normalizeAngle(deg: number) {
	const a = ((deg % 360) + 360) % 360;
	return a > 180 ? a - 360 : a;
}

export function clampScale(v: number) {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));
}

export function transformMatrix(t: ModelTransform) {
	const scale = new Matrix4().makeScale(t.scale.x, t.scale.y, t.scale.z);
	const rotate = new Matrix4().makeRotationFromQuaternion(rotationQuaternion(t.rotation));
	return scale.multiply(rotate);
}

/** A transformed copy of a Z-up geometry. */
export function applyTransform(geometry: BufferGeometry, t: ModelTransform): BufferGeometry {
	const out = geometry.clone();
	if (!isIdentity(t)) {
		out.applyMatrix4(transformMatrix(t));
		out.computeVertexNormals();
	}
	return out;
}

/**
 * Binary STL of the transformed part, centred on the bed origin with its
 * lowest point at Z = 0 — what the slicer should receive.
 */
export function exportSTL(geometry: BufferGeometry, t: ModelTransform): Blob {
	const g = applyTransform(geometry, t);
	g.computeBoundingBox();
	const box = g.boundingBox!;
	const center = box.getCenter(new Vector3());
	g.translate(-center.x, -center.y, -box.min.z);
	const data = new STLExporter().parse(new Mesh(g), { binary: true }) as DataView;
	g.dispose();
	return new Blob([data.buffer as ArrayBuffer], { type: 'model/stl' });
}
