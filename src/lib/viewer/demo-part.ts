import { BufferGeometry, ExtrudeGeometry, LatheGeometry, Path, Shape, Vector2 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function roundedRect(w: number, h: number, r: number) {
	const s = new Shape();
	const x = -w / 2;
	const y = -h / 2;
	s.moveTo(x + r, y);
	s.lineTo(x + w - r, y);
	s.quadraticCurveTo(x + w, y, x + w, y + r);
	s.lineTo(x + w, y + h - r);
	s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	s.lineTo(x + r, y + h);
	s.quadraticCurveTo(x, y + h, x, y + h - r);
	s.lineTo(x, y + r);
	s.quadraticCurveTo(x, y, x + r, y);
	return s;
}

function hole(x: number, y: number, r: number) {
	const p = new Path();
	p.absarc(x, y, r, 0, Math.PI * 2, true);
	return p;
}

function extrude(shape: Shape, depth: number, z = 0) {
	const g = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 48 });
	g.translate(0, 0, z);
	return g;
}

/** Triangular gusset standing on the base plate, profile drawn in the XZ plane. */
function rib(fromX: number, toX: number, base: number, top: number, thickness: number) {
	const s = new Shape();
	s.moveTo(fromX, base);
	s.lineTo(toX, base);
	s.lineTo(fromX, top);
	s.closePath();
	const g = new ExtrudeGeometry(s, { depth: thickness, bevelEnabled: false });
	g.rotateX(Math.PI / 2);
	g.translate(0, thickness / 2, 0);
	return g;
}

/** Make triangle winding face outward (positive signed volume). */
function orientOutward(geometry: BufferGeometry) {
	const pos = geometry.getAttribute('position');
	const arr = pos.array as Float32Array;
	let volume = 0;
	for (let i = 0; i < arr.length; i += 9) {
		const [ax, ay, az, bx, by, bz, cx, cy, cz] = arr.subarray(i, i + 9);
		volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
	}
	if (volume >= 0) return geometry;
	for (let i = 0; i < arr.length; i += 9) {
		for (let k = 0; k < 3; k++) {
			const t = arr[i + 3 + k];
			arr[i + 3 + k] = arr[i + 6 + k];
			arr[i + 6 + k] = t;
		}
	}
	pos.needsUpdate = true;
	return geometry;
}

function positionsOnly(g: BufferGeometry) {
	const flat = g.index ? g.toNonIndexed() : g;
	const plain = new BufferGeometry();
	plain.setAttribute('position', flat.getAttribute('position'));
	return orientOutward(plain);
}

/**
 * A procedural flanged bearing collar (Z-up, mm), used as the placeholder
 * part whenever the viewer has no file to show. Every solid starts on the
 * bed so no hidden internal faces get flagged as overhangs.
 */
export function createDemoPart(): BufferGeometry {
	const plateT = 8;
	const height = 42;
	const bore = 18;
	const outer = 30;

	const base = roundedRect(114.5, 98.2, 10);
	for (const [x, y] of [
		[-44, -36],
		[44, -36],
		[-44, 36],
		[44, 36]
	]) {
		base.holes.push(hole(x, y, 3.5));
	}
	base.holes.push(hole(0, 0, outer));

	// Collar with a flared lip, revolved around the Z axis.
	const profile = [
		[bore, 0],
		[outer, 0],
		[outer, height - 4],
		[outer + 4, height - 4],
		[outer + 4, height],
		[bore + 4, height],
		[bore + 4, height - 3],
		[bore, height - 3],
		[bore, 0]
	].map(([r, z]) => new Vector2(r, z));
	const collar = new LatheGeometry(profile, 96);
	collar.rotateX(Math.PI / 2);

	const parts = [
		extrude(base, plateT),
		collar,
		rib(outer - 1, 52, 0, 30, 6),
		rib(-(outer - 1), -52, 0, 30, 6)
	].map(positionsOnly);

	const merged = mergeGeometries(parts)!;
	merged.computeVertexNormals();
	return merged;
}
