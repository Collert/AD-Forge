/**
 * Anycubic Photon Workshop scenes (.pwscene), for SLA parts.
 *
 * A .pwscene is a zip, reverse-engineered from a Photon Workshop 4.1 file:
 *
 * - header: 100 bytes, "ANYCUBIC-SCENE" and "ANYCUBIC-PC4.1.0" in 16-byte
 *   fields, the save date at 0x20, then five u32s.
 * - meshes/mesh_0.vf: u32 0, u32 3, u32 1, u32 float count, the vertices as
 *   float32 xyz (welded, centred on X/Y, resting on Z = 0), then u32 index
 *   count and the triangles as u32 vertex indices.
 * - mainnodes/node_0.nd: u32 header, the source path and display name (each a
 *   u32 byte length + UTF-8), then fixed fields (colour, transforms, an empty
 *   support tree) copied from the reference file, which leave the mesh as is.
 * - config/anycubic_photon_resins.pwsp: the printer and its resin profiles;
 *   `active_resins` picks one, whose `slicepara.zthick` is the layer height.
 * - preview/image_0.png, image_1.png: 800 × 600 previews (blank until the
 *   customer's snapshot is added on finalizing).
 *
 * Supports and hollowing are not stored: they're added in Photon Workshop.
 */
import { crc32, deflateSync } from 'node:zlib';
import { strToU8, unzipSync, zipSync } from 'fflate';
import machineProfile from './pwscene/anycubic_photon_resins.pwsp?raw';
import resinNames from './pwscene/anycubic_resin_names.json?raw';
import type { Mesh } from './threemf';

const NODE_HEAD = 'AAAAAD8AAAAHAAAAAAAAAA==';
const NODE_TAIL =
	'AQAAAAAAAAABAAAABwAAAAEAAAAAAAAAAACAPwAAgD8AAIA/AACAPwAAAAAAAAAAAAAAAAAAAAAAAIA/AAAAAAAAAAAAAAAAAAAAAAAAgD8AAAAAAACAPgAAgD4AAAAAAACAPwAAgD8AAAAAAAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAAAAAAIA/AAAAAAAAAAAAAAAAAAAAAAAAgD8AAAAAAAAAAAAAAAAAAIA/AAAAAAAAAAABAAAAAAAAAIQD6PuEA+j7AAAAAAAAAAABAAAACwAAAAAAAAAAAIA/AAAAAAAAAAAAAAAAAAAAAAAAgD8AAAAAAAAAAAAAAAAAAAAAAACAPwAAAAAAAIC+AACAvgAAAIAAAIA/AACAPwAAgD8AAIA/CwEAAHsiVHJlZUdyb3VwIjp7ImJhc2VDb25maWciOi0xLCJjb25maWciOnsiY29uZmlnc0NvbnRhaW5lciI6eyJjb25maWdWZWMiOltdfSwiaWRUb0NvbmZpZ01hcCI6W119LCJjcm9zc0Jhck1hcCI6W10sImludmVydF9tYXRyaXgiOlsxLjAsMC4wLDAuMCwwLjAsMC4wLDEuMCwwLjAsMC4wLDAuMCwwLjAsMS4wLDAuMCwwLjAsMC4wLDAuMCwxLjBdLCJtb2RlbENvbmZpZ2ZJZCI6LTEsInByb2plY3RQb2ludHMiOltdLCJzdXBwb3J0VGlwTWFwIjpbXSwidHJlZU1hcCI6W119fQ==';
const PLATES = 'AgAAAAAAAAAAAAAAAEeDRUMAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAA==';
const HEADER_TAIL = 'AwAAAAEAAAABAAAAAQAAAAAAAAA=';

type ResinProfile = { property: { name: string; resin_name: string; setting_name: string } };
type MachineConfig = { machine_type: { print_xsize: number; print_ysize: number; print_zsize: number }; machine_extern: { factory_resins: ResinProfile[] } };

/** The printer's build volume, mm. */
export function pwsceneBed() {
	const { machine_type: m } = JSON.parse(machineProfile) as MachineConfig;
	return { x: m.print_xsize, y: m.print_ysize, z: m.print_zsize };
}

/**
 * Photon Workshop's resin profile for a store resin, matched on its title
 * ("Standard Resin" → standard_resin, "ABS-Like Resin V2" → abs_like_resin_v2)
 * against profile names and their English display names. Standard resin otherwise.
 */
export function resinProfileName(title: string): string {
	const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9.+]+/g, '_').replace(/^_|_$/g, '');
	const want = key(title);
	const names = JSON.parse(resinNames) as { name: string; translation: Record<string, string>[] }[];
	const byEnglish = names.find((n) => key(n.translation.find((t) => t.en)?.en ?? '') === want)?.name;
	const resin = [want, byEnglish].find((n) => n && profiles().some((p) => p.property.resin_name === n)) ?? 'standard_resin';
	const normal = profiles().find((p) => p.property.resin_name === resin && p.property.setting_name === 'normal_print');
	return (normal ?? profiles().find((p) => p.property.resin_name === resin)!).property.name;
}

function profiles() {
	return (JSON.parse(machineProfile) as MachineConfig).machine_extern.factory_resins;
}

/** A scene with one part, `mesh` (centred, on Z = 0), printed in resin profile `resin` at `layerHeight` mm. */
export function buildPwscene(mesh: Mesh, name: string, resin: string, layerHeight: number): Uint8Array {
	const fileName = `${name}.stl`;
	return zipSync({
		'meshes/mesh_0.vf': meshFile(mesh),
		'mainnodes/node_0.nd': concat(base64(NODE_HEAD), text(fileName), text(fileName), base64(NODE_TAIL)),
		'config/anycubic_photon_resins.pwsp': strToU8(resinConfig(resin, layerHeight)),
		'config/anycubic_resin_names.json': strToU8(resinNames),
		'config/custom_resin_names.json': new Uint8Array(0),
		'multi_plates.bin': base64(PLATES),
		'preview/image_0.png': blankPng(800, 600),
		'preview/image_1.png': blankPng(800, 600),
		header: header()
	});
}

/**
 * The printer config with `resin` active at `layerHeight`. Edited as text, so
 * everything else stays exactly as Photon Workshop wrote it (re-serializing
 * would turn its 3.0s into 3s).
 */
function resinConfig(resin: string, layerHeight: number) {
	const at = machineProfile.indexOf(`"name": ${JSON.stringify(resin)}`);
	if (at < 0) throw new Error(`No Photon Workshop resin profile "${resin}"`);
	const zthick = /("zthick":\s*)[-\d.eE]+/g;
	zthick.lastIndex = at;
	const match = zthick.exec(machineProfile);
	if (!match) throw new Error(`Resin profile "${resin}" has no layer height`);
	const edited = machineProfile.slice(0, match.index) + match[1] + layerHeight + machineProfile.slice(match.index + match[0].length);
	return edited.replace(/("active_resins":\s*\[)[^\]]*\]/, `$1\n            ${JSON.stringify(resin)}\n        ]`);
}

/** Use the configurator's snapshot as the scene previews. */
export function withPwscenePreview(scene: Uint8Array, png: Uint8Array<ArrayBuffer>): Uint8Array {
	const files = unzipSync(scene);
	files['preview/image_0.png'] = png;
	files['preview/image_1.png'] = png;
	return zipSync(files);
}

function meshFile(mesh: Mesh) {
	const { vertices, triangles } = mesh;
	const out = new DataView(new ArrayBuffer(16 + vertices.length * 4 + 4 + triangles.length * 4));
	let o = 0;
	for (const v of [0, 3, 1, vertices.length]) (out.setUint32(o, v, true), (o += 4));
	for (const v of vertices) (out.setFloat32(o, v, true), (o += 4));
	out.setUint32(o, triangles.length, true);
	o += 4;
	for (const i of triangles) (out.setUint32(o, i, true), (o += 4));
	return new Uint8Array(out.buffer);
}

function header() {
	const out = new Uint8Array(100);
	out.set(strToU8('ANYCUBIC-SCENE'), 0);
	out.set(strToU8('ANYCUBIC-PC4.1.0'), 0x10);
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	out.set(strToU8(date), 0x20);
	out.set(base64(HEADER_TAIL), 0x50);
	return out;
}

/** A transparent RGBA PNG. */
function blankPng(width: number, height: number) {
	const chunk = (type: string, data: Uint8Array) => {
		const out = new Uint8Array(12 + data.length);
		const view = new DataView(out.buffer);
		view.setUint32(0, data.length);
		out.set(strToU8(type), 4);
		out.set(data, 8);
		view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
		return out;
	};
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	ihdr.set([8, 6, 0, 0, 0], 8);
	// Each row: filter byte 0, then zeroed pixels.
	const pixels = deflateSync(new Uint8Array(height * (1 + width * 4)));
	return concat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', pixels), chunk('IEND', new Uint8Array(0)));
}

/** u32 byte length + UTF-8. */
function text(value: string) {
	const bytes = strToU8(value);
	const out = new Uint8Array(4 + bytes.length);
	new DataView(out.buffer).setUint32(0, bytes.length, true);
	out.set(bytes, 4);
	return out;
}

function base64(value: string) {
	return new Uint8Array(Buffer.from(value, 'base64'));
}

function concat(...parts: Uint8Array[]) {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) (out.set(p, o), (o += p.length));
	return out;
}
