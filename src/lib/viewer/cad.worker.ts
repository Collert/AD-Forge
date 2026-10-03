/// <reference lib="webworker" />
import occtimportjs, { type Occt, type OcctParams } from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';

export type CadRequest = { id: number; format: 'step' | 'iges'; buffer: ArrayBuffer };
export type CadResponse = { id: number; positions: Float32Array } | { id: number; error: string };

/**
 * Fine enough that curved faces read smoothly and fillets tessellate into
 * steps well under the CNC sharp-corner threshold, without bloating the mesh.
 */
const PARAMS: OcctParams = {
	linearUnit: 'millimeter',
	linearDeflectionType: 'bounding_box_ratio',
	linearDeflection: 0.001,
	angularDeflection: 0.3
};

let occt: Promise<Occt> | null = null;

self.onmessage = async (e: MessageEvent<CadRequest>) => {
	const { id, format, buffer } = e.data;
	try {
		occt ??= occtimportjs({ locateFile: () => wasmUrl });
		const lib = await occt;
		const content = new Uint8Array(buffer);
		const result = format === 'iges' ? lib.ReadIgesFile(content, PARAMS) : lib.ReadStepFile(content, PARAMS);
		if (!result.success || result.meshes.length === 0) throw new Error(`Couldn't read this ${format.toUpperCase()} file`);

		// Meshes come back already placed in assembly coordinates; flatten to one triangle soup.
		let count = 0;
		for (const mesh of result.meshes) count += mesh.index.array.length;
		const positions = new Float32Array(count * 3);
		let o = 0;
		for (const mesh of result.meshes) {
			const pos = mesh.attributes.position.array;
			for (const i of mesh.index.array) {
				positions[o++] = pos[i * 3];
				positions[o++] = pos[i * 3 + 1];
				positions[o++] = pos[i * 3 + 2];
			}
		}
		self.postMessage({ id, positions } satisfies CadResponse, [positions.buffer]);
	} catch (err) {
		self.postMessage({ id, error: (err as Error).message || 'Could not read this CAD file' } satisfies CadResponse);
	}
};
