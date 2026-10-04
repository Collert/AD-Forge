/**
 * 3MF packages for OrcaSlicer / Bambu Studio.
 *
 * The slicer is given a minimal 3MF: the part's mesh, plus its print settings
 * as object metadata in Metadata/model_settings.config (Bambu's per-object
 * settings). OrcaSlicer reads those as object-level overrides, slices with
 * them, and exports the full project format around them — that export is the
 * file we keep.
 */
import { strToU8, unzipSync, zipSync } from 'fflate';

export type Mesh = {
	/** xyz per vertex, welded (each shared corner once). */
	vertices: Float32Array;
	/** Three vertex indices per triangle. */
	triangles: Uint32Array;
	size: { x: number; y: number; z: number };
};

/** A binary or ASCII STL as an indexed mesh, moved so it's centred on X/Y = 0 and rests on Z = 0. */
export function parseStl(data: Uint8Array): Mesh {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const count = data.byteLength >= 84 ? view.getUint32(80, true) : -1;
	const corners = count >= 0 && data.byteLength === 84 + count * 50 ? binaryCorners(view, count) : asciiCorners(data);
	if (!corners.length) throw new Error('The model has no triangles.');
	return weld(corners);
}

function binaryCorners(view: DataView, count: number): Float32Array {
	const corners = new Float32Array(count * 9);
	for (let t = 0; t < count; t++) {
		const at = 84 + t * 50 + 12;
		for (let k = 0; k < 9; k++) corners[t * 9 + k] = view.getFloat32(at + k * 4, true);
	}
	return corners;
}

function asciiCorners(data: Uint8Array): Float32Array {
	const text = new TextDecoder().decode(data);
	if (!/^\s*solid/.test(text)) throw new Error('The model is not a valid STL file.');
	const values: number[] = [];
	for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) values.push(+m[1], +m[2], +m[3]);
	if (values.length % 9 || values.some((v) => !Number.isFinite(v))) throw new Error('The model is not a valid STL file.');
	return new Float32Array(values);
}

/** Merge identical corners into shared vertices (3MF meshes are indexed) and drop degenerate triangles. */
function weld(corners: Float32Array): Mesh {
	const bits = new Uint32Array(corners.buffer, corners.byteOffset, corners.length);
	const ids = new Map<string, number>();
	const vertices: number[] = [];
	const triangles: number[] = [];
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];

	for (let t = 0; t < corners.length; t += 9) {
		const tri: number[] = [];
		for (let c = t; c < t + 9; c += 3) {
			const key = `${bits[c]},${bits[c + 1]},${bits[c + 2]}`;
			let id = ids.get(key);
			if (id === undefined) {
				id = vertices.length / 3;
				ids.set(key, id);
				for (let k = 0; k < 3; k++) {
					const v = corners[c + k];
					if (!Number.isFinite(v)) throw new Error('The model has invalid coordinates.');
					vertices.push(v);
					min[k] = Math.min(min[k], v);
					max[k] = Math.max(max[k], v);
				}
			}
			tri.push(id);
		}
		if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) triangles.push(...tri);
	}

	const shift = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]];
	const out = new Float32Array(vertices.length);
	for (let i = 0; i < vertices.length; i++) out[i] = vertices[i] - shift[i % 3];
	return {
		vertices: out,
		triangles: new Uint32Array(triangles),
		size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] }
	};
}

/** Enclosed volume, cm³ (sum of signed tetrahedra; exact for a closed mesh). */
export function meshVolume(mesh: Mesh) {
	const { vertices: v, triangles: t } = mesh;
	let sum = 0;
	for (let i = 0; i < t.length; i += 3) {
		const a = t[i] * 3;
		const b = t[i + 1] * 3;
		const c = t[i + 2] * 3;
		sum +=
			v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
			v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
			v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
	}
	return Math.abs(sum) / 6 / 1000;
}

const CONTENT_TYPES =`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

/**
 * The slicer's input: one object, placed at `position` (the bed centre), with
 * `settings` (Orca option keys) as its object-level overrides.
 *
 * Deliberately a plain 3MF: one that claims to come from Bambu Studio must
 * also carry a full project_settings.config, or the CLI crashes on it.
 */
export function buildInput3mf(mesh: Mesh, name: string, settings: Record<string, string>, position: { x: number; y: number }): Uint8Array {
	const v = mesh.vertices;
	const t = mesh.triangles;
	const lines: string[] = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
		` <metadata name="Title">${xml(name)}</metadata>`,
		' <resources>',
		'  <object id="1" type="model">',
		'   <mesh>',
		'    <vertices>'
	];
	for (let i = 0; i < v.length; i += 3) lines.push(`     <vertex x="${num(v[i])}" y="${num(v[i + 1])}" z="${num(v[i + 2])}"/>`);
	lines.push('    </vertices>', '    <triangles>');
	for (let i = 0; i < t.length; i += 3) lines.push(`     <triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"/>`);
	lines.push(
		'    </triangles>',
		'   </mesh>',
		'  </object>',
		' </resources>',
		' <build>',
		`  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${num(position.x)} ${num(position.y)} 0" printable="1"/>`,
		' </build>',
		'</model>'
	);

	const config = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<config>',
		'  <object id="1">',
		`    <metadata key="name" value="${xml(name)}"/>`,
		'    <metadata key="extruder" value="1"/>',
		...Object.entries(settings).map(([key, value]) => `    <metadata key="${xml(key)}" value="${xml(value)}"/>`),
		'    <part id="1" subtype="normal_part">',
		`      <metadata key="name" value="${xml(name)}"/>`,
		'      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>',
		'    </part>',
		'  </object>',
		'</config>'
	];

	// Stored, not compressed: the slicer reads it once and it's deleted.
	return zipSync(
		{
			'[Content_Types].xml': strToU8(CONTENT_TYPES),
			'_rels/.rels': strToU8(ROOT_RELS),
			'3D/3dmodel.model': strToU8(lines.join('\n')),
			'Metadata/model_settings.config': strToU8(config.join('\n'))
		},
		{ level: 0 }
	);
}

/**
 * Add the plate preview the project's relationships already point at
 * (Metadata/plate_1.png and plate_1_small.png). The CLI can't render it
 * without a GPU, so the configurator's own snapshot is used.
 */
export function withThumbnail(project: Uint8Array, png: Uint8Array<ArrayBuffer>): Uint8Array {
	const files = unzipSync(project);
	files['Metadata/plate_1.png'] = png;
	files['Metadata/plate_1_small.png'] = png;
	return zipSync(files);
}

/** Enough digits to round-trip the float32 value, without float64 noise. */
function num(value: number) {
	return String(+value.toPrecision(9));
}

function xml(text: string) {
	return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
