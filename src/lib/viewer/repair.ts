import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2, Vector3 } from 'three';
import { countOpenEdges } from './analysis';

export type RepairReport = {
	degenerateRemoved: number;
	duplicatesRemoved: number;
	/** Triangles whose winding was flipped to agree with their neighbours. */
	facesFlipped: number;
	holesFilled: number;
	trianglesAdded: number;
	openEdgesBefore: number;
	openEdgesAfter: number;
};

/** Matches the tolerance `countOpenEdges` uses, so "repaired" means the same thing to both. */
const WELD_SCALE = 1e3;

const edgeKey = (p: number, q: number) => (p < q ? p * 0x4000000 + q : q * 0x4000000 + p);

/**
 * Close a mesh so it slices cleanly: weld coincident vertices, drop degenerate
 * and duplicate triangles, make winding consistent (outward-facing), then cap
 * every boundary loop. Expects and returns a non-indexed, position-only
 * geometry in the model's native coordinates.
 */
export function repairMesh(geometry: BufferGeometry): { geometry: BufferGeometry; report: RepairReport } {
	const pos = geometry.getAttribute('position');
	const openEdgesBefore = countOpenEdges(geometry);

	// ---------- Weld ----------
	const ids = new Map<string, number>();
	const verts: number[] = [];
	const weld = (i: number) => {
		const x = pos.getX(i);
		const y = pos.getY(i);
		const z = pos.getZ(i);
		const key = `${Math.round(x * WELD_SCALE)},${Math.round(y * WELD_SCALE)},${Math.round(z * WELD_SCALE)}`;
		let id = ids.get(key);
		if (id === undefined) {
			ids.set(key, (id = ids.size));
			verts.push(x, y, z);
		}
		return id;
	};

	// ---------- Degenerate + duplicate faces ----------
	let tris: number[] = [];
	let degenerateRemoved = 0;
	let duplicatesRemoved = 0;
	const seen = new Set<string>();
	const pa = new Vector3();
	const pb = new Vector3();
	const pc = new Vector3();
	const vertex = (id: number, out: Vector3) => out.fromArray(verts, id * 3);

	for (let t = 0; t < pos.count; t += 3) {
		const a = weld(t);
		const b = weld(t + 1);
		const c = weld(t + 2);
		if (a === b || b === c || a === c) {
			degenerateRemoved++;
			continue;
		}
		// Zero-area slivers (three collinear vertices) have no orientation and can't be sliced.
		vertex(a, pa);
		const area = vertex(b, pb).sub(pa).cross(vertex(c, pc).sub(pa)).lengthSq();
		if (area === 0) {
			degenerateRemoved++;
			continue;
		}
		const key = [a, b, c].sort((m, n) => m - n).join(',');
		if (seen.has(key)) {
			duplicatesRemoved++;
			continue;
		}
		seen.add(key);
		tris.push(a, b, c);
	}

	// ---------- Consistent winding ----------
	const facesFlipped = orientFaces(tris, verts);

	// ---------- Fill holes ----------
	const filled = fillHoles(tris, verts);
	tris = tris.concat(filled.triangles);

	// ---------- Back to a flat geometry ----------
	const out = new Float32Array(tris.length * 3);
	for (let i = 0; i < tris.length; i++) {
		const v = tris[i] * 3;
		out[i * 3] = verts[v];
		out[i * 3 + 1] = verts[v + 1];
		out[i * 3 + 2] = verts[v + 2];
	}
	const repaired = new BufferGeometry();
	repaired.setAttribute('position', new Float32BufferAttribute(out, 3));
	repaired.computeVertexNormals();

	return {
		geometry: repaired,
		report: {
			degenerateRemoved,
			duplicatesRemoved,
			facesFlipped,
			holesFilled: filled.holes,
			trianglesAdded: filled.triangles.length / 3,
			openEdgesBefore,
			openEdgesAfter: countOpenEdges(repaired)
		}
	};
}

/**
 * Flood-fill each connected shell so neighbouring faces wind the same way,
 * then flip any shell whose signed volume is negative (inside-out).
 * Non-manifold edges (3+ faces) don't propagate orientation. Returns faces flipped.
 */
function orientFaces(tris: number[], verts: number[]): number {
	const count = tris.length / 3;
	const edgeFaces = new Map<number, number[]>();
	for (let f = 0; f < count; f++) {
		for (let e = 0; e < 3; e++) {
			const key = edgeKey(tris[f * 3 + e], tris[f * 3 + ((e + 1) % 3)]);
			const list = edgeFaces.get(key);
			if (list) list.push(f);
			else edgeFaces.set(key, [f]);
		}
	}

	/** True if face `f` contains the directed edge p→q. */
	const hasDirected = (f: number, p: number, q: number) => {
		for (let e = 0; e < 3; e++) {
			if (tris[f * 3 + e] === p && tris[f * 3 + ((e + 1) % 3)] === q) return true;
		}
		return false;
	};
	const flip = (f: number) => {
		const t = tris[f * 3 + 1];
		tris[f * 3 + 1] = tris[f * 3 + 2];
		tris[f * 3 + 2] = t;
	};

	const shell = new Int32Array(count).fill(-1);
	const flipped = new Uint8Array(count);
	const a = new Vector3();
	const b = new Vector3();
	const c = new Vector3();
	let flips = 0;
	let shells = 0;

	for (let seed = 0; seed < count; seed++) {
		if (shell[seed] !== -1) continue;
		const id = shells++;
		const members: number[] = [seed];
		shell[seed] = id;
		for (let i = 0; i < members.length; i++) {
			const f = members[i];
			for (let e = 0; e < 3; e++) {
				const p = tris[f * 3 + e];
				const q = tris[f * 3 + ((e + 1) % 3)];
				const faces = edgeFaces.get(edgeKey(p, q))!;
				if (faces.length !== 2) continue;
				const g = faces[0] === f ? faces[1] : faces[0];
				if (shell[g] !== -1) continue;
				// A consistent neighbour runs the shared edge the opposite way (q→p).
				if (hasDirected(g, p, q)) {
					flip(g);
					flipped[g] ^= 1;
				}
				shell[g] = id;
				members.push(g);
			}
		}

		let volume = 0;
		for (const f of members) {
			a.fromArray(verts, tris[f * 3] * 3);
			b.fromArray(verts, tris[f * 3 + 1] * 3);
			c.fromArray(verts, tris[f * 3 + 2] * 3);
			volume += a.dot(b.cross(c));
		}
		if (volume < 0) {
			for (const f of members) {
				flip(f);
				flipped[f] ^= 1;
			}
		}
	}

	for (let f = 0; f < count; f++) flips += flipped[f];
	return flips;
}

/**
 * Find every boundary loop and triangulate it. Fill triangles reuse the
 * loop's vertices and wind opposite to the boundary edges they close, so the
 * result stays consistently oriented.
 */
function fillHoles(tris: number[], verts: number[]): { triangles: number[]; holes: number } {
	const uses = new Map<number, number>();
	for (let i = 0; i < tris.length; i += 3) {
		for (let e = 0; e < 3; e++) {
			const key = edgeKey(tris[i + e], tris[i + ((e + 1) % 3)]);
			uses.set(key, (uses.get(key) ?? 0) + 1);
		}
	}

	// Boundary half-edges, reversed: the hole's rim runs q→p where a face has p→q.
	const next = new Map<number, number[]>();
	for (let i = 0; i < tris.length; i += 3) {
		for (let e = 0; e < 3; e++) {
			const p = tris[i + e];
			const q = tris[i + ((e + 1) % 3)];
			if (uses.get(edgeKey(p, q)) !== 1) continue;
			const list = next.get(q);
			if (list) list.push(p);
			else next.set(q, [p]);
		}
	}

	const loops: number[][] = [];
	for (const start of [...next.keys()]) {
		while (next.get(start)?.length) traceLoops(start, next, loops);
	}
	const triangles: number[] = [];
	for (const loop of loops) triangles.push(...triangulateLoop(loop, verts));
	return { triangles, holes: loops.length };
}

/**
 * Walk boundary edges from `start`, consuming them, and collect each rim that
 * closes. Where several rims touch at one vertex, the stretch since the walk
 * last passed that vertex is split off as its own hole. An open chain (a dead
 * end that can't be capped) is dropped.
 */
function traceLoops(start: number, next: Map<number, number[]>, loops: number[][]) {
	const path = [start];
	const at = new Map<number, number>([[start, 0]]);
	let v = start;
	for (;;) {
		const w = next.get(v)?.pop();
		if (w === undefined) return;
		const seenAt = at.get(w);
		if (seenAt === undefined) {
			at.set(w, path.length);
			path.push(w);
			v = w;
			continue;
		}
		const loop = path.splice(seenAt + 1);
		loop.unshift(w);
		for (const id of loop.slice(1)) at.delete(id);
		if (loop.length >= 3) loops.push(loop);
		if (w === start && !next.get(start)?.length) return;
		v = w;
	}
}

const newell = new Vector3();
const u = new Vector3();
const w = new Vector3();
const p = new Vector3();
const q = new Vector3();

/** Ear-clip a 3D loop on its best-fit plane; fall back to a fan if that fails. */
function triangulateLoop(loop: number[], verts: number[]): number[] {
	if (loop.length === 3) return [loop[0], loop[1], loop[2]];

	// Newell's method: the loop's normal, pointing the way the fill should face.
	newell.set(0, 0, 0);
	for (let i = 0; i < loop.length; i++) {
		p.fromArray(verts, loop[i] * 3);
		q.fromArray(verts, loop[(i + 1) % loop.length] * 3);
		newell.x += (p.y - q.y) * (p.z + q.z);
		newell.y += (p.z - q.z) * (p.x + q.x);
		newell.z += (p.x - q.x) * (p.y + q.y);
	}
	if (newell.lengthSq() === 0) return fan(loop);
	newell.normalize();

	// Orthonormal basis on the plane, with u × w = normal so the loop stays counter-clockwise.
	u.set(1, 0, 0);
	if (Math.abs(newell.x) > 0.9) u.set(0, 1, 0);
	u.sub(w.copy(newell).multiplyScalar(u.dot(newell))).normalize();
	w.crossVectors(newell, u);

	const contour = loop.map((id) => {
		p.fromArray(verts, id * 3);
		return new Vector2(p.dot(u), p.dot(w));
	});
	const faces = ShapeUtils.triangulateShape(contour, []);
	if (faces.length !== loop.length - 2) return fan(loop);

	const out: number[] = [];
	for (const [i, j, k] of faces) {
		const a = contour[i];
		const b = contour[j];
		const c = contour[k];
		const ccw = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0;
		if (ccw) out.push(loop[i], loop[j], loop[k]);
		else out.push(loop[i], loop[k], loop[j]);
	}
	return out;
}

/** Last resort for non-planar or self-overlapping rims: fan from the first vertex. */
function fan(loop: number[]): number[] {
	const out: number[] = [];
	for (let i = 1; i < loop.length - 1; i++) out.push(loop[0], loop[i], loop[i + 1]);
	return out;
}
