import type { ModelTransform } from '$lib/viewer/transform';
import type { MachiningSettings, PrintCost, PrintSettings, ResinSettings } from './estimate';

export type QuoteRequest = {
	/** Customer-facing part name. */
	name: string;
	/** Binary STL with the rotation and scale baked in (ModelViewer.exportModel()). */
	model: Blob;
	/** The original upload, for CNC: the STEP file the part is machined from. */
	source?: File | null;
	/** Rotation and scale applied in the viewer (CNC records them; the STEP file is kept as uploaded). */
	transform?: ModelTransform;
	processId: string;
	/** Which configurator the process uses; extrusion, resin and machining are quoted on the server. */
	processKind: 'extrusion' | 'resin' | 'machining' | 'other';
	materialId: string;
	/** Shopify variant id of the colour / pigment. */
	colorId: string;
	settings: PrintSettings | ResinSettings | MachiningSettings;
};

export type Quote = PrintCost & {
	id: string;
	/** ISO timestamp after which the price must be re-requested. */
	expiresAt: string;
};

/** A finalized quote: the store product it's ordered through. */
export type FinalizedDesign = { productId: string; handle: string; variantId: string; fileName: string };

/** An error with a customer-facing message and the HTTP status behind it. */
export class RequestError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
	}
}

/**
 * Request an accurate quote from the server (see /api/quote): FDM and SLA
 * parts are sliced with OrcaSlicer, CNC parts get their tool access measured.
 * Processes without online ordering wait a moment and echo the local estimate
 * (`fallback`).
 */
export async function requestQuote(request: QuoteRequest, fallback: PrintCost): Promise<Quote> {
	if (!isOrderable(request.processKind)) {
		await new Promise((resolve) => setTimeout(resolve, 1400));
		return { ...fallback, id: crypto.randomUUID(), expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString() };
	}
	const { model, source, processKind, ...body } = request;
	void processKind;
	const form = new FormData();
	form.set('model', model, 'model.stl');
	if (source) form.set('source', source, source.name);
	form.set('request', JSON.stringify(body));
	return post('/api/quote', form, 'Could not get a quote. Please try again.');
}

/** Processes whose quotes are sliced on the server and can be finalized into an order. */
export function isOrderable(kind: QuoteRequest['processKind']) {
	return kind === 'extrusion' || kind === 'resin' || kind === 'machining';
}

/** Save a quoted part (its 3MF and a store product to order it through). Needs a signed-in customer. */
export function finalizeDesign(quoteId: string, name: string, thumbnail: Blob | null): Promise<FinalizedDesign> {
	const form = new FormData();
	form.set('quoteId', quoteId);
	form.set('name', name);
	if (thumbnail) form.set('thumbnail', thumbnail, 'preview.png');
	return post('/api/designs', form, "Couldn't save your design. Please try again.");
}

async function post<T>(url: string, body: FormData, fallbackMessage: string): Promise<T> {
	let res: Response;
	try {
		res = await fetch(url, { method: 'POST', body });
	} catch {
		throw new RequestError('Could not reach the server. Check your connection and try again.', 0);
	}
	if (!res.ok) {
		const message = await res.json().then((b: { message?: string }) => b.message, () => undefined);
		throw new RequestError(message || fallbackMessage, res.status);
	}
	return res.json();
}
