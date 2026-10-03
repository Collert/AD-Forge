import { STORES, promisify, transact } from './db';

const CHANNEL = 'ad-forge-shelf';

/** Live number of parts on the Shelf, for the header badge. */
export const shelf = $state({ count: 0 });

let channel: BroadcastChannel | null = null;

export async function refreshShelfCount() {
	try {
		shelf.count = await transact([STORES.parts], 'readonly', (tx) =>
			promisify(tx.objectStore(STORES.parts).count())
		);
	} catch {
		// Storage unavailable (private mode, blocked site data): leave the badge as is.
	}
}

/** Call after parts are added or removed so every open tab updates its badge. */
export function notifyShelfChanged() {
	refreshShelfCount();
	channel?.postMessage('changed');
}

/** Start tracking the count. Returns a cleanup function. */
export function watchShelfCount() {
	refreshShelfCount();
	channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel(CHANNEL) : null;
	if (channel) channel.onmessage = () => refreshShelfCount();
	return () => {
		channel?.close();
		channel = null;
	};
}
