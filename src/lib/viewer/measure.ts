import { BufferGeometry, DoubleSide, EdgesGeometry, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/** What a click picks: any surface point, the nearest mesh vertex, or a circular edge. */
export type MeasureMode = 'point' | 'vertex' | 'circle';

export type CircleFit = {
	center: Vector3;
	normal: Vector3;
	radius: number;
	/** True when the edge loop closes; false for an arc. */
	closed: boolean;
};

/** Edges sharper than this count as feature edges (circle rims, corners). */
const FEATURE_ANGLE = 25;
/** A chain stops at a turn sharper than this: it's a corner, not a tessellated curve. */
const MAX_TURN = (55 * Math.PI) / 180;
/** Points may stray this far (fraction of the radius) from the fitted circle. */
const FIT_TOLERANCE = 0.03;
const MAX_CHAIN = 4096;

const _v = new Vector3();
const _w = new Vector3();

/**
 * Picking helpers for one displayed (Y-up, non-indexed) part. Builds its BVH
 * and feature-edge graph lazily, on first use.
 */
export class MeasurePicker {
	private bvh: MeshBVH | null = null;
	private edges: {
		/** Welded vertex positions (xyz). */
		points: Float32Array;
		/** Segment endpoints as indices into `points`. */
		segments: Uint32Array;
		/** Segments touching each vertex. */
		adjacency: number[][];
	} | null = null;

	constructor(private geometry: BufferGeometry) {}

	/** Closest surface hit along a ray, ignoring anything above `maxY` (the layer cut). */
	raycast(ray: Ray, maxY = Infinity): { point: Vector3; face: number } | null {
		this.bvh ??= new MeshBVH(this.geometry, { indirect: true });
		const hits = this.bvh.raycast(ray, DoubleSide);
		let best: { point: Vector3; face: number; distance: number } | null = null;
		for (const hit of hits) {
			if (hit.point.y > maxY + 1e-6 || hit.faceIndex == null) continue;
			if (!best || hit.distance < best.distance) {
				best = { point: hit.point.clone(), face: hit.faceIndex, distance: hit.distance };
			}
		}
		return best && { point: best.point, face: best.face };
	}

	/** The corner of a hit triangle nearest to the hit point. */
	snapToVertex(point: Vector3, face: number): Vector3 {
		const pos = this.geometry.getAttribute('position');
		let best = new Vector3();
		let bestDist = Infinity;
		for (let k = 0; k < 3; k++) {
			_v.fromBufferAttribute(pos, face * 3 + k);
			const d = _v.distanceToSquared(point);
			if (d < bestDist) {
				bestDist = d;
				best = _v.clone();
			}
		}
		return best;
	}

	/**
	 * The circle (or arc) formed by the feature edges nearest `point`, if that
	 * edge is within `reach` mm and its neighbours really lie on a circle.
	 */
	findCircle(point: Vector3, reach: number): CircleFit | null {
		const graph = this.featureEdges();
		const { points, segments } = graph;
		const segCount = segments.length / 2;
		if (!segCount) return null;

		// Nearest feature edge to the picked point.
		let nearest = -1;
		let nearestDist = reach * reach;
		const a = new Vector3();
		const b = new Vector3();
		for (let s = 0; s < segCount; s++) {
			a.fromArray(points, segments[s * 2] * 3);
			b.fromArray(points, segments[s * 2 + 1] * 3);
			const d = distanceToSegmentSq(point, a, b);
			if (d < nearestDist) {
				nearestDist = d;
				nearest = s;
			}
		}
		if (nearest < 0) return null;

		// Walk the edge chain both ways, following the smoothest continuation.
		const start = segments[nearest * 2];
		const end = segments[nearest * 2 + 1];
		const forward = this.walk(end, start, nearest);
		let closed = forward.length > 0 && forward[forward.length - 1] === start;
		const backward = closed ? [] : this.walk(start, end, nearest);
		if (closed) forward.pop();

		// Ordered chain of vertex indices; the clicked edge sits at [pivot, pivot + 1].
		let chain = [...backward.reverse(), start, end, ...forward];
		let pivot = backward.length;
		if (closed) {
			// Rotate the loop so the clicked edge sits mid-chain and the fit can grow both ways.
			const half = Math.floor(chain.length / 2);
			chain = [...chain.slice(chain.length - half), ...chain.slice(0, chain.length - half)];
			pivot = half;
		}
		const at = (i: number) => new Vector3().fromArray(points, chain[i] * 3);

		// Seed with the clicked edge and a neighbour or two either side, then grow while points stay on the circle.
		let lo = pivot;
		let hi = pivot + 1;
		const grow = (side: 'lo' | 'hi') => {
			if (side === 'lo' && lo > 0) return lo--, true;
			if (side === 'hi' && hi < chain.length - 1) return hi++, true;
			return false;
		};
		// Only seed with neighbours of similar length: a tessellated curve's facets are alike.
		const clicked = at(pivot).distanceTo(at(pivot + 1));
		const similar = (i: number, j: number) => {
			const len = at(i).distanceTo(at(j));
			return len < clicked * 3 && len > clicked / 3;
		};
		for (let k = 0; k < 2; k++) {
			if (lo > 0 && similar(lo - 1, lo)) grow('lo');
			if (hi < chain.length - 1 && similar(hi, hi + 1)) grow('hi');
		}
		if (hi - lo + 1 < 3) return null;

		let fit = fitCircle(chain.slice(lo, hi + 1).map((_, i) => at(lo + i)));
		if (!fit) return null;

		for (const side of ['lo', 'hi'] as const) {
			let added = 0;
			for (;;) {
				const next = side === 'lo' ? lo - 1 : hi + 1;
				if (next < 0 || next >= chain.length) break;
				if (distanceToCircle(at(next), fit) > fit.radius * FIT_TOLERANCE) break;
				grow(side);
				if (++added % 8 === 0) fit = fitCircle(chain.slice(lo, hi + 1).map((_, i) => at(lo + i))) ?? fit;
			}
		}

		const used = chain.slice(lo, hi + 1).map((_, i) => at(lo + i));
		fit = fitCircle(used);
		if (!fit) return null;
		for (const p of used) if (distanceToCircle(p, fit) > fit.radius * FIT_TOLERANCE) return null;
		// Each segment of a tessellated curve spans a small angle; a long straight edge between two fillets doesn't.
		for (let i = 1; i < used.length; i++) {
			const chord = used[i].distanceTo(used[i - 1]);
			if (2 * Math.asin(Math.min(1, chord / (2 * fit.radius))) > MAX_TURN) return null;
		}

		// A straight run "fits" a huge circle; insist on real curvature.
		const sweep = arcSweep(used, fit);
		if (sweep < (40 * Math.PI) / 180) return null;

		closed = closed && lo === 0 && hi === chain.length - 1;
		return { ...fit, closed };
	}

	/** Vertex indices visited from `from`, having arrived along `via` from `prev`. Ends with the start vertex if it loops. */
	private walk(from: number, prev: number, via: number): number[] {
		const { points, segments, adjacency } = this.featureEdges();
		const out: number[] = [];
		const visited = new Set<number>([via]);
		const seen = new Set<number>([from]);
		let cur = from;
		let last = prev;
		const dirIn = new Vector3();
		const dirOut = new Vector3();
		const p = new Vector3();
		while (out.length < MAX_CHAIN) {
			p.fromArray(points, cur * 3);
			dirIn.subVectors(p, _w.fromArray(points, last * 3)).normalize();
			let bestSeg = -1;
			let bestNext = -1;
			let bestTurn = MAX_TURN;
			for (const s of adjacency[cur]) {
				if (visited.has(s)) continue;
				const next = segments[s * 2] === cur ? segments[s * 2 + 1] : segments[s * 2];
				dirOut.subVectors(_v.fromArray(points, next * 3), p).normalize();
				const turn = Math.acos(Math.min(1, Math.max(-1, dirIn.dot(dirOut))));
				if (turn < bestTurn) {
					bestTurn = turn;
					bestSeg = s;
					bestNext = next;
				}
			}
			// Back at the start: the loop is closed.
			if (bestSeg < 0) break;
			if (bestNext === prev) {
				out.push(bestNext);
				break;
			}
			// Ran into our own tail (a figure-6): stop before it.
			if (seen.has(bestNext)) break;
			visited.add(bestSeg);
			seen.add(bestNext);
			out.push(bestNext);
			last = cur;
			cur = bestNext;
		}
		return out;
	}

	private featureEdges() {
		if (this.edges) return this.edges;
		const lines = new EdgesGeometry(this.geometry, FEATURE_ANGLE);
		const raw = lines.getAttribute('position').array as Float32Array;
		lines.dispose();

		// EdgesGeometry repeats shared endpoints; weld them so the chain can be walked.
		const keyOf = (i: number) =>
			`${Math.round(raw[i] * 1e4)},${Math.round(raw[i + 1] * 1e4)},${Math.round(raw[i + 2] * 1e4)}`;
		const ids = new Map<string, number>();
		const pts: number[] = [];
		const segments = new Uint32Array(raw.length / 3);
		for (let v = 0; v < raw.length / 3; v++) {
			const key = keyOf(v * 3);
			let id = ids.get(key);
			if (id === undefined) {
				id = pts.length / 3;
				ids.set(key, id);
				pts.push(raw[v * 3], raw[v * 3 + 1], raw[v * 3 + 2]);
			}
			segments[v] = id;
		}
		const adjacency: number[][] = Array.from({ length: pts.length / 3 }, () => []);
		for (let s = 0; s < segments.length / 2; s++) {
			adjacency[segments[s * 2]].push(s);
			adjacency[segments[s * 2 + 1]].push(s);
		}
		this.edges = { points: new Float32Array(pts), segments, adjacency };
		return this.edges;
	}

	dispose() {
		this.bvh = null;
		this.edges = null;
	}
}

function distanceToSegmentSq(p: Vector3, a: Vector3, b: Vector3) {
	const ab = _v.subVectors(b, a);
	const len = ab.lengthSq();
	const t = len ? Math.min(1, Math.max(0, _w.subVectors(p, a).dot(ab) / len)) : 0;
	return _w.copy(a).addScaledVector(ab, t).distanceToSquared(p);
}

/** Distance from a point to the circle's rim (not its disc). */
function distanceToCircle(p: Vector3, c: { center: Vector3; normal: Vector3; radius: number }) {
	const d = new Vector3().subVectors(p, c.center);
	const off = d.dot(c.normal);
	const inPlane = d.addScaledVector(c.normal, -off).length();
	return Math.hypot(inPlane - c.radius, off);
}

/** Angle the points span around the centre (2π for a full loop). */
function arcSweep(pts: Vector3[], c: { center: Vector3; normal: Vector3 }) {
	let total = 0;
	const u = new Vector3();
	const w = new Vector3();
	for (let i = 1; i < pts.length; i++) {
		u.subVectors(pts[i - 1], c.center);
		w.subVectors(pts[i], c.center);
		total += Math.atan2(new Vector3().crossVectors(u, w).dot(c.normal), u.dot(w));
	}
	return Math.abs(total);
}

/** Least-squares circle through 3D points: best plane, then an algebraic (Kåsa) fit in it. */
export function fitCircle(pts: Vector3[]): { center: Vector3; normal: Vector3; radius: number } | null {
	if (pts.length < 3) return null;
	const centroid = new Vector3();
	for (const p of pts) centroid.add(p);
	centroid.divideScalar(pts.length);

	// Plane normal from summed cross products around the centroid (works for arcs as well as loops).
	const normal = new Vector3();
	const u = new Vector3();
	const w = new Vector3();
	for (let i = 1; i < pts.length; i++) {
		u.subVectors(pts[i - 1], centroid);
		w.subVectors(pts[i], centroid);
		normal.add(new Vector3().crossVectors(u, w));
	}
	if (normal.lengthSq() < 1e-18) {
		// Fallback: the first non-degenerate triple.
		for (let i = 2; i < pts.length && normal.lengthSq() < 1e-18; i++) {
			normal.crossVectors(u.subVectors(pts[1], pts[0]), w.subVectors(pts[i], pts[0]));
		}
		if (normal.lengthSq() < 1e-18) return null;
	}
	normal.normalize();

	const ex = new Vector3().subVectors(pts[0], centroid);
	ex.addScaledVector(normal, -ex.dot(normal));
	if (ex.lengthSq() < 1e-18) ex.set(1, 0, 0).addScaledVector(normal, -normal.x);
	ex.normalize();
	const ey = new Vector3().crossVectors(normal, ex);

	// Solve [Σx² Σxy Σx; Σxy Σy² Σy; Σx Σy n] [D E F]ᵀ = −[Σx(x²+y²); Σy(x²+y²); Σ(x²+y²)].
	let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
	for (const p of pts) {
		const d = u.subVectors(p, centroid);
		const x = d.dot(ex);
		const y = d.dot(ey);
		const z = x * x + y * y;
		sxx += x * x;
		sxy += x * y;
		syy += y * y;
		sx += x;
		sy += y;
		sxz += x * z;
		syz += y * z;
		sz += z;
	}
	const n = pts.length;
	const solved = solve3(
		[
			[sxx, sxy, sx],
			[sxy, syy, sy],
			[sx, sy, n]
		],
		[-sxz, -syz, -sz]
	);
	if (!solved) return null;
	const [D, E, F] = solved;
	const cx = -D / 2;
	const cy = -E / 2;
	const r2 = cx * cx + cy * cy - F;
	if (!(r2 > 0)) return null;
	const center = centroid.clone().addScaledVector(ex, cx).addScaledVector(ey, cy);
	return { center, normal, radius: Math.sqrt(r2) };
}

function solve3(m: number[][], v: number[]): [number, number, number] | null {
	const det = (a: number[][]) =>
		a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
		a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
		a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
	const d = det(m);
	const scale = Math.abs(m[0][0] * m[1][1] * m[2][2]);
	if (!scale || Math.abs(d) < scale * 1e-12) return null;
	const col = (k: number) => m.map((row, i) => row.map((x, j) => (j === k ? v[i] : x)));
	return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}
