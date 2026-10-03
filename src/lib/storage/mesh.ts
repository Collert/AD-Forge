import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Stored geometry, laid out like a 3MF `<mesh>`: a shared vertex list and
 * triangles that index into it (millimetres, Z up, as uploaded — rotation
 * and scale live on the part, not baked in here).
 */
export type MeshData = {
	/** Layout version, so the format can evolve. */
	version: 1;
	unit: 'millimeter';
	/** x, y, z per vertex — `<vertex x y z>`. */
	vertices: Float32Array;
	/** v1, v2, v3 per triangle — `<triangle v1 v2 v3>`. */
	triangles: Uint32Array;
	/**
	 * Optional per-triangle paint, one entry per triangle, using the same
	 * encoding as the 3MF `paint_color` attribute (e.g. "8", "1C", or a
	 * subdivision string). `null` means unpainted. Absent when nothing is painted.
	 */
	paint?: (string | null)[];
};

export function triangleCount(mesh: MeshData) {
	return mesh.triangles.length / 3;
}

/** Index a (usually non-indexed) geometry into 3MF-style vertices + triangles. */
export function geometryToMesh(geometry: BufferGeometry): MeshData {
	const positionsOnly = new BufferGeometry();
	positionsOnly.setAttribute('position', geometry.getAttribute('position'));
	if (geometry.index) positionsOnly.setIndex(geometry.index);

	const indexed = mergeVertices(positionsOnly, 1e-5);
	const vertices = new Float32Array(indexed.getAttribute('position').array as ArrayLike<number>);
	const triangles = Uint32Array.from(indexed.index!.array as ArrayLike<number>);
	indexed.dispose();

	return { version: 1, unit: 'millimeter', vertices, triangles };
}

/** Rebuild an indexed BufferGeometry from stored mesh data. */
export function meshToGeometry(mesh: MeshData): BufferGeometry {
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new Float32BufferAttribute(mesh.vertices, 3));
	geometry.setIndex(new Uint32BufferAttribute(mesh.triangles, 1));
	return geometry;
}
