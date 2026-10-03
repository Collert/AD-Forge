import type { PrintSettings } from '$lib/pricing/estimate';
import type { Quote } from '$lib/pricing/quote';
import type { ModelTransform } from '$lib/viewer/transform';
import { STORES, promisify, transact } from './db';
import type { MeshData } from './mesh';
import { notifyShelfChanged } from './shelf.svelte';

/** Every configurator selection needed to reopen a part exactly as it was left. */
export type PartConfig = {
	mode: 'simple' | 'advanced';
	categoryId: string;
	materialId: string;
	/** Shopify variant id of the filament colour; absent on parts saved before the store catalog. */
	colorId?: string;
	qualityId: string;
	fdm: Omit<PrintSettings, 'layerHeight'>;
	/** SLA selections; absent on parts saved before SLA existed. */
	resin?: ResinConfig;
	/** CNC selections; absent on parts saved before CNC existed. */
	machining?: MachiningConfig;
};

export type MachiningConfig = { materialId: string; axes: 'three' | 'four' };

/** `pigmentId` is the Shopify variant id; absent on parts saved before the store catalog. */
export type ResinConfig = { resinId: string; pigmentId?: string; qualityId: string; shellId: string };

export type SpecChip = { icon: string; label: string };

/** Denormalised facts the Shelf shows without touching the mesh. */
export type PartSummary = {
	size: { x: number; y: number; z: number };
	volume: number;
	triangles: number;
	/** Errors + warnings from the printability checks. */
	issues: number;
	specs: SpecChip[];
	/** Rough instant estimate for one unit, $. */
	estimateTotal: number;
	/** Accurate quoted price for one unit, if the saved quote matches the saved settings. */
	quotedTotal: number | null;
};

export type PartRecord = {
	id: string;
	name: string;
	fileName: string;
	/** Lower-case extension of the original upload, e.g. "stl". */
	format: string;
	/** Size of the original upload in bytes. */
	fileSize: number;
	processId: string;
	config: PartConfig;
	transform: ModelTransform;
	summary: PartSummary | null;
	/** Last accurate quote and the configuration key it is valid for. */
	quote: { key: string; result: Quote } | null;
	/** Isometric PNG render of the part on a transparent background. */
	thumbnail: Blob | null;
	createdAt: number;
	updatedAt: number;
};

export type StoredMesh = MeshData & { id: string };

export async function createPart(part: PartRecord, mesh: MeshData): Promise<void> {
	await transact([STORES.parts, STORES.meshes], 'readwrite', (tx) => {
		tx.objectStore(STORES.parts).put(part);
		tx.objectStore(STORES.meshes).put({ ...mesh, id: part.id } satisfies StoredMesh);
	});
	notifyShelfChanged();
}

/** Merge `patch` into a part. Resolves to the updated record, or null if it no longer exists. */
export async function updatePart(
	id: string,
	patch: Partial<Omit<PartRecord, 'id' | 'createdAt'>>
): Promise<PartRecord | null> {
	return transact([STORES.parts], 'readwrite', async (tx) => {
		const store = tx.objectStore(STORES.parts);
		const current = (await promisify(store.get(id))) as PartRecord | undefined;
		if (!current) return null;
		const next: PartRecord = { ...current, ...patch, id, updatedAt: Date.now() };
		store.put(next);
		return next;
	});
}

/** Swap in new geometry for a part, e.g. after a mesh repair. */
export async function replaceMesh(id: string, mesh: MeshData): Promise<void> {
	await transact([STORES.meshes], 'readwrite', (tx) => {
		tx.objectStore(STORES.meshes).put({ ...mesh, id } satisfies StoredMesh);
	});
}

export async function getPart(id: string): Promise<PartRecord | null> {
	return transact([STORES.parts], 'readonly', async (tx) => {
		return ((await promisify(tx.objectStore(STORES.parts).get(id))) as PartRecord) ?? null;
	});
}

export async function getMesh(id: string): Promise<StoredMesh | null> {
	return transact([STORES.meshes], 'readonly', async (tx) => {
		return ((await promisify(tx.objectStore(STORES.meshes).get(id))) as StoredMesh) ?? null;
	});
}

/** All parts, most recently edited first. Never loads meshes. */
export async function listParts(): Promise<PartRecord[]> {
	const parts = await transact([STORES.parts], 'readonly', (tx) =>
		promisify(tx.objectStore(STORES.parts).getAll() as IDBRequest<PartRecord[]>)
	);
	return parts.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deletePart(id: string): Promise<void> {
	await transact([STORES.parts, STORES.meshes], 'readwrite', (tx) => {
		tx.objectStore(STORES.parts).delete(id);
		tx.objectStore(STORES.meshes).delete(id);
	});
	notifyShelfChanged();
}

/**
 * Coalesces rapid edits into one write per part. Patches made within `delay`
 * ms are merged; `flush()` writes immediately (e.g. before leaving the page).
 */
export function createPartSaver(delay = 400) {
	const pending = new Map<string, Partial<PartRecord>>();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let chain: Promise<unknown> = Promise.resolve();

	function flush() {
		if (timer) clearTimeout(timer);
		timer = null;
		const batch = [...pending];
		pending.clear();
		chain = chain.then(() =>
			Promise.all(batch.map(([id, patch]) => updatePart(id, patch).catch(console.error)))
		);
		return chain;
	}

	return {
		save(id: string, patch: Partial<PartRecord>) {
			pending.set(id, { ...pending.get(id), ...patch });
			if (timer) clearTimeout(timer);
			timer = setTimeout(flush, delay);
		},
		flush
	};
}
