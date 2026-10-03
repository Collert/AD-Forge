import { BufferGeometry, Quaternion, Vector3 } from 'three';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';
import type { BedSize } from './analysis';
import { rotationFromQuaternion, rotationQuaternion, type ModelTransform } from './transform';

export type FitResult =
	| { status: 'already' }
	| { status: 'rotated'; rotation: ModelTransform['rotation'] }
	| { status: 'impossible' };

/** Outcome of the last "Try to fit"; null until it runs. */
export type OrientationFit = FitResult['status'] | null;

/** Tilt directions sampled over the sphere (plus the six axes). */
const TILT_SAMPLES = 480;
/** Spin step around the vertical axis, degrees. */
const SPIN_STEP = 2;
const EPSILON = 1e-4;

/**
 * Convex-hull vertices of a geometry. Extents under any rotation only depend
 * on these, so the orientation search can skip the rest of the mesh.
 */
export function hullPoints(geometry: BufferGeometry): Float32Array {
	const pos = geometry.getAttribute('position');
	const unique = new Map<string, Vector3>();
	for (let i = 0; i < pos.count; i++) {
		const x = pos.getX(i);
		const y = pos.getY(i);
		const z = pos.getZ(i);
		const key = `${Math.round(x * 1e3)},${Math.round(y * 1e3)},${Math.round(z * 1e3)}`;
		if (!unique.has(key)) unique.set(key, new Vector3(x, y, z));
	}
	const points = [...unique.values()];
	let vertices: Vector3[] = points;
	if (points.length >= 4) {
		try {
			vertices = new ConvexHull().setFromPoints(points).vertices.map((v) => v.point);
		} catch {
			// Degenerate (flat) meshes have no hull; fall back to all points.
		}
	}
	const out = new Float32Array(vertices.length * 3);
	vertices.forEach((v, i) => v.toArray(out, i * 3));
	return out;
}

function sphereDirections(count: number): Vector3[] {
	const dirs = [
		new Vector3(0, 0, 1),
		new Vector3(0, 0, -1),
		new Vector3(1, 0, 0),
		new Vector3(-1, 0, 0),
		new Vector3(0, 1, 0),
		new Vector3(0, -1, 0)
	];
	const golden = Math.PI * (3 - Math.sqrt(5));
	for (let i = 0; i < count; i++) {
		const z = 1 - (2 * (i + 0.5)) / count;
		const r = Math.sqrt(1 - z * z);
		const phi = i * golden;
		dirs.push(new Vector3(r * Math.cos(phi), r * Math.sin(phi), z));
	}
	return dirs;
}

function extents(points: Float32Array, q: Quaternion, scale: ModelTransform['scale']) {
	const v = new Vector3();
	let minX = Infinity, minY = Infinity, minZ = Infinity;
	let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
	for (let i = 0; i < points.length; i += 3) {
		v.set(points[i], points[i + 1], points[i + 2]).applyQuaternion(q);
		if (v.x < minX) minX = v.x;
		if (v.x > maxX) maxX = v.x;
		if (v.y < minY) minY = v.y;
		if (v.y > maxY) maxY = v.y;
		if (v.z < minZ) minZ = v.z;
		if (v.z > maxZ) maxZ = v.z;
	}
	return {
		x: (maxX - minX) * scale.x,
		y: (maxY - minY) * scale.y,
		z: (maxZ - minZ) * scale.z
	};
}

const fitsBed = (size: { x: number; y: number; z: number }, bed: BedSize) =>
	size.x <= bed.x + EPSILON && size.y <= bed.y + EPSILON && size.z <= bed.z + EPSILON;

/**
 * Find a rotation that makes the part fit the build volume at its current
 * scale. Never changes scale. Among fitting orientations it picks the one
 * closest to the current rotation, so the user's intent is kept where
 * possible.
 */
export function findFittingRotation(
	points: Float32Array,
	transform: ModelTransform,
	bed: BedSize
): FitResult {
	const current = rotationQuaternion(transform.rotation);
	if (fitsBed(extents(points, current, transform.scale), bed)) return { status: 'already' };

	const zAxis = new Vector3(0, 0, 1);
	const currentUp = zAxis.clone().applyQuaternion(current.clone().invert());
	const tilt = new Quaternion();
	const spin = new Quaternion();
	const candidate = new Quaternion();
	const rotated = new Float32Array(points.length);
	const v = new Vector3();

	let best: Quaternion | null = null;
	let bestAngle = Infinity;

	for (const up of [currentUp, ...sphereDirections(TILT_SAMPLES)]) {
		tilt.setFromUnitVectors(up, zAxis);

		// Height doesn't depend on the spin, so check it once per tilt.
		let minZ = Infinity, maxZ = -Infinity;
		for (let i = 0; i < points.length; i += 3) {
			v.set(points[i], points[i + 1], points[i + 2]).applyQuaternion(tilt);
			rotated[i] = v.x;
			rotated[i + 1] = v.y;
			rotated[i + 2] = v.z;
			if (v.z < minZ) minZ = v.z;
			if (v.z > maxZ) maxZ = v.z;
		}
		if ((maxZ - minZ) * transform.scale.z > bed.z + EPSILON) continue;

		for (let deg = 0; deg < 180; deg += SPIN_STEP) {
			const a = (deg * Math.PI) / 180;
			const cos = Math.cos(a);
			const sin = Math.sin(a);
			let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
			for (let i = 0; i < rotated.length; i += 3) {
				const x = cos * rotated[i] - sin * rotated[i + 1];
				const y = sin * rotated[i] + cos * rotated[i + 1];
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
			if ((maxX - minX) * transform.scale.x > bed.x + EPSILON) continue;
			if ((maxY - minY) * transform.scale.y > bed.y + EPSILON) continue;

			spin.setFromAxisAngle(zAxis, a);
			candidate.multiplyQuaternions(spin, tilt);
			const angle = candidate.angleTo(current);
			if (angle < bestAngle) {
				bestAngle = angle;
				best = candidate.clone();
			}
		}
	}

	if (!best) return { status: 'impossible' };
	// Prefer tidy angles, but not at the cost of a tight fit.
	const tidy = rotationFromQuaternion(best);
	const tidyFits = fitsBed(extents(points, rotationQuaternion(tidy), transform.scale), bed);
	return { status: 'rotated', rotation: tidyFits ? tidy : rotationFromQuaternion(best, Infinity) };
}
