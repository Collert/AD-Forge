/**
 * Minimal promise wrapper around the browser's IndexedDB.
 *
 * Stores:
 * - `parts`  — small part records (settings, summary, thumbnail). Listed by the Shelf.
 * - `meshes` — heavy geometry, keyed by part id. Only read when a part is opened.
 * - `sources` — the original upload, keyed by part id, kept only where the mesh
 *   isn't enough (STEP files, which CNC orders are machined from).
 */

const DB_NAME = 'ad-forge';
const DB_VERSION = 2;

export const STORES = { parts: 'parts', meshes: 'meshes', sources: 'sources' } as const;
type StoreName = (typeof STORES)[keyof typeof STORES];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORES.parts)) {
				const parts = db.createObjectStore(STORES.parts, { keyPath: 'id' });
				parts.createIndex('updatedAt', 'updatedAt');
			}
			if (!db.objectStoreNames.contains(STORES.meshes)) {
				db.createObjectStore(STORES.meshes, { keyPath: 'id' });
			}
			if (!db.objectStoreNames.contains(STORES.sources)) {
				db.createObjectStore(STORES.sources, { keyPath: 'id' });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => {
			dbPromise = null;
			reject(request.error);
		};
	});
	// Ask the browser not to evict our data under storage pressure (best effort).
	navigator.storage?.persist?.().catch(() => {});
	return dbPromise;
}

export function promisify<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** Run `work` inside one transaction and resolve once it has committed. */
export async function transact<T>(
	stores: StoreName[],
	mode: IDBTransactionMode,
	work: (tx: IDBTransaction) => T | Promise<T>
): Promise<T> {
	const db = await openDb();
	const tx = db.transaction(stores, mode);
	const done = new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
	});
	const result = await work(tx);
	await done;
	return result;
}
