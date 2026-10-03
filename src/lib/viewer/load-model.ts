import { BufferGeometry, Float32BufferAttribute, Mesh, type Object3D } from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { meshToGeometry, type MeshData } from '$lib/storage/mesh';
import type { ModelTransform } from './transform';
import type { CadRequest, CadResponse } from './cad.worker';

import { PREVIEWABLE_FORMATS, type PreviewFormat } from './formats';

export { MODEL_ACCEPT, PREVIEWABLE_FORMATS, type PreviewFormat } from './formats';

/** A part that was already loaded once and saved to the browser's storage. */
export type StoredModel = {
	kind: 'stored';
	/** Original file name, e.g. "bracket.stl". */
	name: string;
	mesh: MeshData;
	/** Rotation/scale to restore instead of starting from identity. */
	transform?: ModelTransform;
};

export type ModelSource = File | string | StoredModel;

export function isStoredModel(source: ModelSource | null | undefined): source is StoredModel {
	return typeof source === 'object' && source !== null && 'kind' in source && source.kind === 'stored';
}

function sourceName(source: ModelSource) {
	if (typeof source === 'string') return new URL(source, 'http://x').pathname;
	return source.name;
}

export function formatOf(source: ModelSource): string {
	return sourceName(source).split('.').pop()?.toLowerCase() ?? '';
}

export function nameOf(source: ModelSource): string {
	if (typeof source !== 'string') return source.name;
	return decodeURIComponent(sourceName(source).split('/').pop() ?? source);
}

export function isPreviewable(format: string): format is PreviewFormat {
	return (PREVIEWABLE_FORMATS as readonly string[]).includes(format);
}

async function readBuffer(source: File | string, signal?: AbortSignal): Promise<ArrayBuffer> {
	if (typeof source !== 'string') return source.arrayBuffer();
	const res = await fetch(source, { signal });
	if (!res.ok) throw new Error(`Failed to fetch model (${res.status})`);
	return res.arrayBuffer();
}

let cadWorker: Worker | null = null;
let cadRequests = 0;

/**
 * Tessellate a STEP / IGES file with OpenCascade (WASM) in a worker. The
 * converter is ~7.6 MB, so it only downloads the first time a CAD file is opened.
 */
async function readCad(buffer: ArrayBuffer, format: 'step' | 'iges', signal?: AbortSignal): Promise<BufferGeometry> {
	if (!cadWorker) {
		const { default: CadWorker } = await import('./cad.worker?worker');
		cadWorker ??= new CadWorker();
	}
	const worker = cadWorker;
	const id = ++cadRequests;
	const positions = await new Promise<Float32Array>((resolve, reject) => {
		const onMessage = (e: MessageEvent<CadResponse>) => {
			if (e.data.id !== id) return;
			worker.removeEventListener('message', onMessage);
			if ('error' in e.data) reject(new Error(e.data.error));
			else resolve(e.data.positions);
		};
		worker.addEventListener('message', onMessage);
		signal?.addEventListener('abort', () => {
			worker.removeEventListener('message', onMessage);
			reject(new DOMException('Aborted', 'AbortError'));
		});
		worker.postMessage({ id, format, buffer } satisfies CadRequest, [buffer]);
	});
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
	return geometry;
}

/** Flatten every mesh in a loaded scene graph into one position-only geometry. */
function flatten(root: Object3D): BufferGeometry {
	root.updateMatrixWorld(true);
	const parts: BufferGeometry[] = [];
	root.traverse((child) => {
		if (!(child instanceof Mesh)) return;
		const src = child.geometry as BufferGeometry;
		const g = new BufferGeometry();
		g.setAttribute('position', src.getAttribute('position').clone());
		if (src.index) g.setIndex(src.index.clone());
		g.applyMatrix4(child.matrixWorld);
		parts.push(g.index ? g.toNonIndexed() : g);
	});
	if (parts.length === 0) throw new Error('No mesh geometry found in file');
	const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts);
	if (!merged) throw new Error('Could not merge model geometry');
	return merged;
}

/** Strip everything but positions and de-index, so normals come out flat like a slicer view. */
function normalize(geometry: BufferGeometry): BufferGeometry {
	const flat = geometry.index ? geometry.toNonIndexed() : geometry;
	const out = new BufferGeometry();
	out.setAttribute(
		'position',
		new Float32BufferAttribute(flat.getAttribute('position').array as Float32Array, 3)
	);
	out.computeVertexNormals();
	return out;
}

/**
 * Load a printable model and return a non-indexed geometry in its native
 * (Z-up, millimetre) coordinates.
 */
export async function loadModel(
	source: ModelSource,
	format = formatOf(source),
	signal?: AbortSignal
): Promise<BufferGeometry> {
	if (isStoredModel(source)) return normalize(meshToGeometry(source.mesh));
	if (!isPreviewable(format)) {
		throw new Error(`3D preview isn't available for .${format || 'unknown'} files`);
	}
	const buffer = await readBuffer(source, signal);

	switch (format) {
		case 'stl':
			return normalize(new STLLoader().parse(buffer));
		case 'ply':
			return normalize(new PLYLoader().parse(buffer));
		case 'obj':
			return normalize(flatten(new OBJLoader().parse(new TextDecoder().decode(buffer))));
		case '3mf':
			return normalize(flatten(new ThreeMFLoader().parse(buffer)));
		case 'step':
		case 'stp':
			return normalize(await readCad(buffer, 'step', signal));
		case 'iges':
		case 'igs':
			return normalize(await readCad(buffer, 'iges', signal));
	}
}
