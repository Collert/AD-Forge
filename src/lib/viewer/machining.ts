import { BufferGeometry, DoubleSide, Float32BufferAttribute, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/**
 * Directions a cutter can come from. The six faces of the stock are the
 * 3-axis setups (flip / re-clamp between them); the rotary is a 4-axis
 * setup turning around X.
 */
export const SIDES = ['right', 'left', 'back', 'front', 'top', 'bottom'] as const;
export type Side = (typeof SIDES)[number];
const SIDE_BITS = 0b111111;
const ROTARY_BIT = 1 << 6;
const sideBit = (side: Side) => 1 << SIDES.indexOf(side);

/**
 * How reachable the part is for a milling cutter, in its current
 * orientation (Z = spindle axis, X = rotary axis). Ray tests stand in for
 * the tool, so they model a very thin cutter — a real end mill's diameter
 * makes access slightly worse, never better.
 */
export type MachiningProfile = {
	/**
	 * mm² of surface by which directions reach it: index = bitmask of SIDES
	 * (bits 0–5) plus the rotary (bit 6). Index 0 is reachable from nowhere.
	 */
	access: Float64Array;
	/** mm² of faces buried inside overlapping solids (internal, never machined). */
	buriedArea: number;
	/** Total length (mm) of sharp internal corners running vertically (along the spindle). */
	sharpCorners: number;
	/**
	 * Pocket floors reachable from the top, as (area mm², depth mm, width mm)
	 * triples: depth below the part top, width of the pocket or slot around it.
	 */
	floors: Float32Array;
	/** Largest distance (mm) of the part from the X axis through its bounding-box centre — the round bar a 4-axis job needs. */
	rotaryRadius: number;
	/** The part seen from above: area covered (mm²) and outline length including holes (mm) — what a cut-out profile follows. */
	footprint: { area: number; perimeter: number };
	/**
	 * Machined surface by how it's finished, mm²: vertical walls (side of the
	 * cutter), flat floors and undersides, and curved or sloped faces (3D
	 * stepover). The top and bottom planes are left out — they're the stock's own faces.
	 */
	surfaces: { walls: number; flats: number; curved: number };
};

const MAX_SAMPLES = 60_000;
const ROTARY_STEPS = 24;
/** Faces this close to facing away from the tool still count as reachable (vertical walls are cut by the flank). */
const FACING_TOLERANCE = -0.02;
/** Interior angle between face normals beyond which a concave edge is a sharp corner, not a tessellated fillet. */
const SHARP_COS = Math.cos((50 * Math.PI) / 180);
/** Edges within ~18° of the tool axis count as running along it. */
const AXIS_ALIGNED = 0.95;
const MIN_POCKET_DEPTH = 0.5;

const a = new Vector3();
const b = new Vector3();
const c = new Vector3();
const ab = new Vector3();
const ac = new Vector3();
const n = new Vector3();
const centroid = new Vector3();
const origin = new Vector3();
const ray = new Ray();

const SIDE_DIRS = [
	new Vector3(1, 0, 0),
	new Vector3(-1, 0, 0),
	new Vector3(0, 1, 0),
	new Vector3(0, -1, 0),
	new Vector3(0, 0, 1),
	new Vector3(0, 0, -1)
];
const TOP = SIDES.indexOf('top');
/** Around X, skipping the four that are already side directions. */
const ROTARY_DIRS = Array.from({ length: ROTARY_STEPS }, (_, k) => {
	const t = (k / ROTARY_STEPS) * Math.PI * 2;
	return new Vector3(0, Math.cos(t), Math.sin(t));
}).filter((d) => Math.abs(d.y) > 1e-6 && Math.abs(d.z) > 1e-6);
/** Tilted probe for the buried-face test, so it doesn't run along coplanar faces. */
const PROBE_TILT = new Vector3(0.31, 0.17, 0.11);
const probe = new Vector3();
const HORIZONTAL_PAIRS = [0, 30, 60, 90, 120, 150].map((deg) => {
	const t = (deg * Math.PI) / 180;
	return new Vector3(Math.cos(t), Math.sin(t), 0);
});
const back = new Vector3();
const hitA = new Vector3();
const hitB = new Vector3();

/** Expects a closed, outward-facing, non-indexed geometry in mm, Z up. */
export function analyzeMachining(positions: Float32Array): MachiningProfile {
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
	geometry.computeBoundingBox();
	const box = geometry.boundingBox!;
	const offset = Math.max(box.getSize(new Vector3()).length() * 1e-6, 1e-4);
	const bvh = new MeshBVH(geometry);
	const triangles = positions.length / 9;

	const clear = (from: Vector3, d: Vector3) => {
		ray.set(from, d);
		return !bvh.raycastFirst(ray, DoubleSide);
	};
	const distance = (from: Vector3, d: Vector3) => {
		ray.set(from, d);
		return bvh.raycastFirst(ray, DoubleSide)?.distance ?? Infinity;
	};
	/** Leaving the face outward lands inside material when the first wall hit faces away (we're exiting a solid). */
	const insideMaterial = (d: Vector3) => {
		ray.set(origin, d);
		const hit = bvh.raycastFirst(ray, DoubleSide);
		return !!hit?.face && hit.face.normal.dot(d) > 0;
	};
	/**
	 * Width of the pocket around `p`: slide to the middle of the longest
	 * wall-to-wall chord (the centre of a round pocket, the centre line of a
	 * slot), then take the shortest chord there. Infinity when open on every side.
	 */
	const pocketWidth = (p: Vector3) => {
		let width = Infinity;
		for (let pass = 0; pass < 3; pass++) {
			let shortest = Infinity;
			let longest = -1;
			for (const d of HORIZONTAL_PAIRS) {
				const da = distance(p, d);
				const db = distance(p, back.copy(d).negate());
				const chord = da + db;
				if (!Number.isFinite(chord)) continue;
				shortest = Math.min(shortest, chord);
				if (chord > longest) {
					longest = chord;
					hitA.copy(p).addScaledVector(d, da);
					hitB.copy(p).addScaledVector(d, -db);
				}
			}
			width = shortest;
			if (longest < 0 || pass === 2) break;
			p.addVectors(hitA, hitB).multiplyScalar(0.5);
		}
		return width;
	};
	const reachable = (d: Vector3) => n.dot(d) >= FACING_TOLERANCE && clear(origin, d);

	const access = new Float64Array(1 << 7);
	const surfaces = { walls: 0, flats: 0, curved: 0 };
	let buriedArea = 0;
	const floors: number[] = [];
	const stride = Math.max(1, Math.ceil(triangles / MAX_SAMPLES));

	for (let t = 0; t < triangles; t += stride) {
		a.fromArray(positions, t * 9);
		b.fromArray(positions, t * 9 + 3);
		c.fromArray(positions, t * 9 + 6);
		n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
		const doubleArea = n.length();
		if (doubleArea === 0) continue;
		n.divideScalar(doubleArea);
		const area = (doubleArea / 2) * Math.min(stride, triangles - t);
		centroid.addVectors(a, b).add(c).divideScalar(3);
		origin.copy(centroid).addScaledVector(n, offset);

		// Faces where overlapping solids meet sit inside the material; they're never cut.
		if (insideMaterial(n) && insideMaterial(probe.copy(n).add(PROBE_TILT).normalize())) {
			buriedArea += area;
			continue;
		}

		let mask = 0;
		SIDE_DIRS.forEach((d, i) => {
			if (reachable(d)) mask |= 1 << i;
		});
		// The underside resting on the stock is the stock's own face (or parted off), cut along with the top.
		if (n.z < -0.99 && centroid.z <= box.min.z + 0.01) mask |= 1 << TOP;
		const rotaryReach = mask & (sideBit('back') | sideBit('front') | sideBit('top') | sideBit('bottom'));
		if (rotaryReach || ROTARY_DIRS.some(reachable)) mask |= ROTARY_BIT;
		access[mask] += area;

		const flat = Math.abs(n.z) > 0.99;
		const stockFace = flat && (n.z > 0 ? centroid.z >= box.max.z - 0.01 : centroid.z <= box.min.z + 0.01);
		if (Math.abs(n.z) < 0.1) surfaces.walls += area;
		else if (flat && !stockFace) surfaces.flats += area;
		else if (!flat) surfaces.curved += area;

		if (mask & (1 << TOP) && n.z > 0.95) {
			const depth = box.max.z - centroid.z;
			if (depth < MIN_POCKET_DEPTH) continue;
			origin.copy(centroid).setZ(centroid.z + Math.min(0.05, depth / 2));
			const width = pocketWidth(origin);
			if (Number.isFinite(width)) floors.push(area, depth, width);
		}
	}

	geometry.dispose();
	return {
		access,
		buriedArea,
		sharpCorners: sharpCorners(positions),
		floors: Float32Array.from(floors),
		rotaryRadius: rotaryRadius(positions, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2),
		footprint: footprint(positions, box.min.x, box.min.y, box.max.x, box.max.y),
		surfaces
	};
}

/** Cells along the longer side of the top-view raster. */
const FOOTPRINT_CELLS = 512;

/**
 * Rasterise the part's top-down shadow. Area counts covered cells; the
 * outline is traced with marching squares (diagonal steps), so curves and
 * slants read within a few percent instead of as a staircase.
 */
function footprint(positions: Float32Array, minX: number, minY: number, maxX: number, maxY: number) {
	const cell = Math.max(maxX - minX, maxY - minY, 1e-6) / FOOTPRINT_CELLS;
	const w = Math.ceil((maxX - minX) / cell) + 1;
	const h = Math.ceil((maxY - minY) / cell) + 1;
	const grid = new Uint8Array(w * h);

	for (let i = 0; i < positions.length; i += 9) {
		const ax = (positions[i] - minX) / cell;
		const ay = (positions[i + 1] - minY) / cell;
		const bx = (positions[i + 3] - minX) / cell;
		const by = (positions[i + 4] - minY) / cell;
		const cx = (positions[i + 6] - minX) / cell;
		const cy = (positions[i + 7] - minY) / cell;
		const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
		if (Math.abs(area) < 1e-12) continue;
		const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
		const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
		const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
		const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
		// Cell centres inside the projected triangle (either winding).
		for (let y = y0; y <= y1; y++) {
			const py = y + 0.5;
			for (let x = x0; x <= x1; x++) {
				const px = x + 0.5;
				const e0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
				const e1 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
				const e2 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
				if ((e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0)) grid[y * w + x] = 1;
			}
		}
	}

	let covered = 0;
	for (const v of grid) covered += v;

	// Walk every 2×2 block of cells (padding the border with empty cells) and add its contour segment(s).
	const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? grid[y * w + x] : 0);
	const half = Math.SQRT1_2;
	let length = 0;
	for (let y = -1; y < h; y++) {
		for (let x = -1; x < w; x++) {
			const n = at(x, y) + at(x + 1, y) + at(x, y + 1) + at(x + 1, y + 1);
			if (n === 1 || n === 3) length += half; // a corner cut diagonally
			else if (n === 2) {
				const diagonal = at(x, y) === at(x + 1, y + 1);
				length += diagonal ? 2 * half : 1; // saddle: two diagonals; else a straight edge
			}
		}
	}
	return { area: covered * cell * cell, perimeter: length * cell };
}

export type SetupPlan = {
	/** Setups needed to reach everything reachable (each flip or re-clamp is one). */
	setups: number;
	/** The 3-axis sides machined, top first; 4-axis plans list the rotary first. */
	sides: (Side | 'rotary')[];
	/** mm² no allowed direction reaches. */
	hidden: number;
	/** Unreachable area (mm²) below which leftovers are ignored as noise, for this part. */
	threshold: number;
};

/**
 * Fewest setups that reach all reachable surface, ignoring leftovers under
 * `minArea` mm² or `minShare` of the surface (slivers in tight corners that a
 * thin ray can't see). 3-axis picks from the six stock faces, preferring the
 * top; 4-axis always uses the rotary and adds the X-end faces if needed.
 */
export function planSetups(profile: MachiningProfile, axes: 'three' | 'four', minArea: number, minShare = 0): SetupPlan {
	const { access } = profile;
	const threshold = Math.max(minArea, access.reduce((sum, v) => sum + v, 0) * minShare);
	const candidates = axes === 'three' ? SIDE_BITS : sideBit('right') | sideBit('left');
	const required = axes === 'three' ? 0 : ROTARY_BIT;
	const allowed = candidates | required;

	let hidden = 0;
	for (let m = 0; m < access.length; m++) if ((m & allowed) === 0) hidden += access[m];

	let best: { set: number; size: number; top: number; missed: number } | null = null;
	for (let set = 0; set <= SIDE_BITS; set++) {
		if ((set & candidates) !== set) continue;
		const chosen = set | required;
		if (chosen === 0) continue;
		let missed = 0;
		for (let m = 0; m < access.length; m++) if ((m & allowed) !== 0 && (m & chosen) === 0) missed += access[m];
		if (missed >= threshold) continue;
		// Fewest setups, then ones that include the top, then the least left over.
		const size = popcount(chosen);
		const top = chosen & sideBit('top') ? 1 : 0;
		const better =
			!best ||
			size < best.size ||
			(size === best.size && (top > best.top || (top === best.top && missed < best.missed)));
		if (better) best = { set: chosen, size, top, missed };
	}

	const set = best?.set ?? (allowed & SIDE_BITS) | required;
	const sides: SetupPlan['sides'] = [];
	if (set & ROTARY_BIT) sides.push('rotary');
	for (const side of ['top', 'bottom', 'front', 'back', 'left', 'right'] as const) if (set & sideBit(side)) sides.push(side);
	return { setups: Math.max(1, sides.length), sides, hidden, threshold };
}

function popcount(v: number) {
	let count = 0;
	for (; v; v &= v - 1) count++;
	return count;
}

/** Concave edges a rotating cutter can't make sharp: the corner keeps the tool's radius. */
function sharpCorners(positions: Float32Array): number {
	const ids = new Map<string, number>();
	const vertexId = (i: number) => {
		const key = `${Math.round(positions[i * 3] * 1e3)},${Math.round(positions[i * 3 + 1] * 1e3)},${Math.round(positions[i * 3 + 2] * 1e3)}`;
		let id = ids.get(key);
		if (id === undefined) ids.set(key, (id = ids.size));
		return id;
	};

	// Edge → the triangles using it (and which vertex of each is opposite the edge).
	const edges = new Map<number, number[]>();
	const triangles = positions.length / 9;
	for (let t = 0; t < triangles; t++) {
		const v = [vertexId(t * 3), vertexId(t * 3 + 1), vertexId(t * 3 + 2)];
		for (let e = 0; e < 3; e++) {
			const p = v[e];
			const q = v[(e + 1) % 3];
			if (p === q) continue;
			const key = p < q ? p * 0x4000000 + q : q * 0x4000000 + p;
			const list = edges.get(key);
			// Store triangle index and the local index of the vertex opposite this edge.
			const entry = t * 3 + ((e + 2) % 3);
			if (list) list.push(entry);
			else edges.set(key, [entry]);
		}
	}

	const nA = new Vector3();
	const nB = new Vector3();
	const p = new Vector3();
	const q = new Vector3();
	const opposite = new Vector3();
	const edge = new Vector3();
	const normalOf = (t: number, out: Vector3) => {
		a.fromArray(positions, t * 9);
		b.fromArray(positions, t * 9 + 3);
		c.fromArray(positions, t * 9 + 6);
		return out.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();
	};

	let total = 0;
	for (const list of edges.values()) {
		if (list.length !== 2) continue;
		const [ea, eb] = list;
		const ta = Math.floor(ea / 3);
		const tb = Math.floor(eb / 3);
		normalOf(ta, nA);
		normalOf(tb, nB);
		if (nA.dot(nB) > SHARP_COS) continue;

		// Edge endpoints are A's two non-opposite vertices.
		const oa = ea % 3;
		p.fromArray(positions, ta * 9 + ((oa + 1) % 3) * 3);
		q.fromArray(positions, ta * 9 + ((oa + 2) % 3) * 3);
		opposite.fromArray(positions, tb * 9 + (eb % 3) * 3);
		// Concave when B folds up in front of A's outward face.
		if (nA.dot(opposite.sub(p)) <= 1e-6) continue;

		edge.subVectors(q, p);
		const length = edge.length();
		if (length > 0 && Math.abs(edge.z) / length > AXIS_ALIGNED) total += length;
	}
	return total;
}

function rotaryRadius(positions: Float32Array, cy: number, cz: number) {
	let max = 0;
	for (let i = 0; i < positions.length; i += 3) {
		const dy = positions[i + 1] - cy;
		const dz = positions[i + 2] - cz;
		max = Math.max(max, dy * dy + dz * dz);
	}
	return Math.sqrt(max);
}

export type Cutter = { diameter: number; reach: number };

/**
 * Pocket floors against the tool kit: a floor can be cut when some cutter
 * fits its width and reaches its depth. Reports what's too narrow for any
 * cutter, what's too deep for every cutter that fits, and the extremes.
 */
export function pocketStats(profile: MachiningProfile, cutters: Cutter[]) {
	const f = profile.floors;
	const smallest = Math.min(...cutters.map((c) => c.diameter));
	let narrowArea = 0;
	let deepArea = 0;
	/** The floor furthest beyond reach, with the longest cutter that fits it. */
	let worst: { depth: number; width: number; reach: number } | null = null;
	/** The deepest floor that can be cut. */
	let deepest: { depth: number; width: number } | null = null;
	for (let i = 0; i < f.length; i += 3) {
		const [area, depth, width] = [f[i], f[i + 1], f[i + 2]];
		if (width < smallest) {
			narrowArea += area;
			continue;
		}
		const reach = Math.max(...cutters.filter((c) => c.diameter <= width).map((c) => c.reach));
		if (depth > reach) {
			deepArea += area;
			if (!worst || depth - reach > worst.depth - worst.reach) worst = { depth, width, reach };
		} else if (!deepest || depth > deepest.depth) {
			deepest = { depth, width };
		}
	}
	return { smallest, narrowArea, deepArea, worst, deepest };
}
