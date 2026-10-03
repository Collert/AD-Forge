import type { ModelSource } from '$lib/viewer/load-model';
import type { ModelTransform } from '$lib/viewer/transform';
import type { MachiningSettings, PrintCost, PrintSettings, ResinSettings } from './estimate';

export type QuoteRequest = {
	/** Customer-facing part name. */
	name: string;
	/** The original upload; apply `transform` server-side (or send ModelViewer.exportModel() instead). */
	source: ModelSource;
	/** Rotation (deg, XYZ) then scale, in printer coordinates. */
	transform: ModelTransform;
	processId: string;
	materialId: string;
	colorHex: string;
	settings: PrintSettings | ResinSettings | MachiningSettings;
};

export type Quote = PrintCost & {
	id: string;
	/** ISO timestamp after which the price must be re-requested. */
	expiresAt: string;
};

/**
 * Request an accurate, sliced quote.
 *
 * TODO: call the slicing backend. Until then this stub waits a moment and
 * echoes the local estimate (`fallback`) so the UI flow can be exercised.
 */
export async function requestQuote(request: QuoteRequest, fallback: PrintCost): Promise<Quote> {
	void request;
	await new Promise((resolve) => setTimeout(resolve, 1400));
	return {
		...fallback,
		id: crypto.randomUUID(),
		expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
	};
}
