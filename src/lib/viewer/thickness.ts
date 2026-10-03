import { BufferGeometry, DoubleSide, Float32BufferAttribute, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/**
 * Local wall thickness across the surface, sorted thinnest first, so any
 * threshold (which depends on the nozzle / process) is a quick lookup.
 */
export type ThicknessProfile = {
	/** mm, ascending. */
	thickness: Float32Array;
	/** mm² of surface at or below `thickness[i]`. */
	cumulativeArea: Float32Array;
	/** mm² of surface that was measured (misses on open or tangled meshes are left out). */
	measuredArea: number;
};

/** Triangles sampled at most; bigger meshes are strided, with each sample standing in for its neighbours. */
const MAX_SAMPLES = 60_000;
/** Rays per sample: one along the inward normal plus a ring around it. */
const RING_RAYS = 6;
/** Wide enough to skip past a single stray face, narrow enough that slabs read within ~3.5%. */
const CONE_ANGLE = (15 * Math.PI) / 180;

const a = new Vector3();
const b = new Vector3();
const c = new Vector3();
const ab = new Vector3();
const ac = new Vector3();
const normal = new Vector3();
const tangent = new Vector3();
const bitangent = new Vector3();
const origin = new Vector3();
const dir = new Vector3();
const ray = new Ray();

/**
 * Measure how thick the part is under each triangle (a shape-diameter
 * estimate): cast a small cone of rays inward from the face and take the
 * median distance to where they leave the solid. Thin walls, fins and pins
 * all come out as small values. Expects a closed, non-indexed geometry in mm.
 */
export function measureThickness(positions: Float32Array): ThicknessProfile {
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
	const triangles = positions.length / 9;

	// Inside-out meshes would cast every ray into empty space.
	let volume = 0;
	for (let t = 0; t < triangles; t++) {
		a.fromArray(positions, t * 9);
		b.fromArray(positions, t * 9 + 3);
		c.fromArray(positions, t * 9 + 6);
		volume += a.dot(b.cross(c));
	}
	const inward = volume < 0 ? 1 : -1;

	geometry.computeBoundingBox();
	const diagonal = geometry.boundingBox!.getSize(new Vector3()).length();
	const offset = Math.max(diagonal * 1e-6, 1e-5);
	const bvh = new MeshBVH(geometry);

	const stride = Math.max(1, Math.ceil(triangles / MAX_SAMPLES));
	const values: number[] = [];
	const areas: number[] = [];
	const hits: number[] = [];

	for (let t = 0; t < triangles; t += stride) {
		a.fromArray(positions, t * 9);
		b.fromArray(positions, t * 9 + 3);
		c.fromArray(positions, t * 9 + 6);
		normal.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
		const doubleArea = normal.length();
		if (doubleArea === 0) continue;
		normal.multiplyScalar(inward / doubleArea);

		tangent.subVectors(b, a).normalize();
		bitangent.crossVectors(normal, tangent);
		origin.addVectors(a, b).add(c).divideScalar(3).addScaledVector(normal, offset);

		hits.length = 0;
		for (let r = 0; r <= RING_RAYS; r++) {
			if (r === 0) dir.copy(normal);
			else {
				const phi = (r / RING_RAYS) * Math.PI * 2;
				const s = Math.sin(CONE_ANGLE);
				dir
					.copy(normal)
					.multiplyScalar(Math.cos(CONE_ANGLE))
					.addScaledVector(tangent, s * Math.cos(phi))
					.addScaledVector(bitangent, s * Math.sin(phi));
			}
			ray.set(origin, dir);
			const hit = bvh.raycastFirst(ray, DoubleSide);
			// Only count rays that leave the solid through a wall facing away from us.
			if (!hit?.face || hit.face.normal.dot(dir) * -inward <= 0) continue;
			hits.push(hit.distance + offset);
		}
		if (hits.length * 2 < RING_RAYS + 1) continue;
		hits.sort((m, n) => m - n);
		values.push(hits[hits.length >> 1]);
		areas.push((doubleArea / 2) * Math.min(stride, triangles - t));
	}
	geometry.dispose();

	const order = values.map((_, i) => i).sort((m, n) => values[m] - values[n]);
	const thickness = new Float32Array(order.length);
	const cumulativeArea = new Float32Array(order.length);
	let total = 0;
	order.forEach((i, k) => {
		thickness[k] = values[i];
		total += areas[i];
		cumulativeArea[k] = total;
	});
	return { thickness, cumulativeArea, measuredArea: total };
}

/** mm² of surface thinner than `limit` mm. */
export function areaThinnerThan(profile: ThicknessProfile, limit: number): number {
	let lo = 0;
	let hi = profile.thickness.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (profile.thickness[mid] < limit) lo = mid + 1;
		else hi = mid;
	}
	return lo === 0 ? 0 : profile.cumulativeArea[lo - 1];
}

/**
 * Thinnest wall worth reporting: the thickness of the thinnest `minArea` mm²
 * of surface, so a stray sliver triangle doesn't define the answer.
 */
export function thinnestWall(profile: ThicknessProfile, minArea: number): number | null {
	const n = profile.thickness.length;
	if (n === 0) return null;
	for (let i = 0; i < n; i++) if (profile.cumulativeArea[i] >= minArea) return profile.thickness[i];
	return profile.thickness[n - 1];
}
