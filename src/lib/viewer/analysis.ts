import { Box3, BufferAttribute, BufferGeometry, Vector3 } from 'three';
import type { MachiningProfile } from './machining';
import type { ThicknessProfile } from './thickness';

/** Build volume of a machine, in millimetres (z = vertical). */
export type BedSize = { x: number; y: number; z: number };

export type ModelInfo = {
	name: string;
	/** Bounding box in printer coordinates (mm, z = height). */
	size: { x: number; y: number; z: number };
	/** cm³ */
	volume: number;
	/** cm² */
	surfaceArea: number;
	/** cm² of downward faces steeper than the overhang threshold. */
	overhangArea: number;
	triangles: number;
	/** Edges used by only one triangle — non-zero means the mesh isn't watertight. */
	openEdges: number;
	fitsBed: boolean;
	/** Local wall thickness across the surface; null while it's still being measured. */
	thickness: ThicknessProfile | null;
	/** CNC tool access; null while measuring or when the viewer isn't asked for it. */
	machining: MachiningProfile | null;
};

const a = new Vector3();
const b = new Vector3();
const c = new Vector3();
const ab = new Vector3();
const ac = new Vector3();
const n = new Vector3();

/** Faces touching the bed are never counted as overhangs. */
const BED_TOLERANCE_MM = 0.3;

/**
 * Mark downward faces that need support. `angle` follows slicer convention:
 * degrees from vertical, so 45° flags anything flatter than a 45° slope.
 * Expects a non-indexed, Y-up geometry resting on y = 0.
 */
export function overhangMask(geometry: BufferGeometry, angle: number) {
	const pos = geometry.getAttribute('position');
	const count = pos.count / 3;
	const mask = new Uint8Array(count);
	const threshold = Math.sin((angle * Math.PI) / 180);
	let area = 0;

	for (let i = 0; i < count; i++) {
		a.fromBufferAttribute(pos, i * 3);
		b.fromBufferAttribute(pos, i * 3 + 1);
		c.fromBufferAttribute(pos, i * 3 + 2);
		if (Math.min(a.y, b.y, c.y) < BED_TOLERANCE_MM) continue;
		n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
		const len = n.length();
		if (len === 0) continue;
		if (-n.y / len > threshold) {
			mask[i] = 1;
			area += len / 2;
		}
	}
	return { mask, area: area / 100 };
}

export function countOpenEdges(geometry: BufferGeometry): number {
	const pos = geometry.getAttribute('position');
	const ids = new Map<string, number>();
	const vertexId = (i: number) => {
		const key = `${Math.round(pos.getX(i) * 1e3)},${Math.round(pos.getY(i) * 1e3)},${Math.round(pos.getZ(i) * 1e3)}`;
		let id = ids.get(key);
		if (id === undefined) ids.set(key, (id = ids.size));
		return id;
	};

	const edges = new Map<number, number>();
	for (let t = 0; t < pos.count; t += 3) {
		const v = [vertexId(t), vertexId(t + 1), vertexId(t + 2)];
		for (let e = 0; e < 3; e++) {
			const p = v[e];
			const q = v[(e + 1) % 3];
			if (p === q) continue;
			const key = p < q ? p * 0x4000000 + q : q * 0x4000000 + p;
			edges.set(key, (edges.get(key) ?? 0) + 1);
		}
	}

	let open = 0;
	for (const uses of edges.values()) if (uses === 1) open++;
	return open;
}

export function analyzeGeometry(
	geometry: BufferGeometry,
	name: string,
	bed: BedSize,
	overhangAngle: number,
	/** Pass a cached count — rotating or scaling never changes topology. */
	openEdges = countOpenEdges(geometry)
): ModelInfo {
	const pos = geometry.getAttribute('position');
	let volume = 0;
	let surface = 0;

	for (let i = 0; i < pos.count; i += 3) {
		a.fromBufferAttribute(pos, i);
		b.fromBufferAttribute(pos, i + 1);
		c.fromBufferAttribute(pos, i + 2);
		volume += a.dot(n.crossVectors(b, c)) / 6;
		surface += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
	}

	const box = new Box3().setFromBufferAttribute(pos as BufferAttribute);
	const dims = box.getSize(new Vector3());
	// Scene is Y-up; report in printer terms where Z is height.
	const size = { x: dims.x, y: dims.z, z: dims.y };

	return {
		name,
		size,
		volume: Math.abs(volume) / 1000,
		surfaceArea: surface / 100,
		overhangArea: overhangMask(geometry, overhangAngle).area,
		triangles: pos.count / 3,
		openEdges,
		fitsBed: size.x <= bed.x && size.y <= bed.y && size.z <= bed.z,
		thickness: null,
		machining: null
	};
}
