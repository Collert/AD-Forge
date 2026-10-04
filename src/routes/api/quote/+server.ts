import { error, json } from '@sveltejs/kit';
import { getCatalog } from '$lib/server/catalog';
import { SlicerError } from '$lib/server/slicer/orca';
import { createQuote, type QuoteRequestBody } from '$lib/server/slicer/quotes';
import type { RequestHandler } from './$types';

/** Largest STL accepted, bytes (~2M triangles). */
const MAX_MODEL_BYTES = 100 * 1024 * 1024;

/**
 * Slice a part and price it. Multipart form: `model` (binary STL with the
 * customer's rotation and scale applied), `request` (JSON QuoteRequestBody),
 * and for CNC `source`, the original STEP file.
 */
export const POST: RequestHandler = async ({ request }) => {
	const form = await request.formData().catch(() => error(400, 'Expected a multipart form.'));
	const model = form.get('model');
	if (!(model instanceof File) || model.size === 0) error(400, 'Missing the model file.');
	const source = form.get('source');
	if (model.size > MAX_MODEL_BYTES || (source instanceof File && source.size > MAX_MODEL_BYTES)) {
		error(413, 'The model is too large to quote online. Please contact us for a quote.');
	}

	let body: QuoteRequestBody | null = null;
	try {
		body = JSON.parse(String(form.get('request')));
	} catch {
		// Handled below.
	}
	if (!body || typeof body !== 'object') error(400, 'Invalid quote request.');

	try {
		const original = source instanceof File && source.size > 0 ? source : undefined;
		return json(await createQuote(body, new Uint8Array(await model.arrayBuffer()), await getCatalog(), original));
	} catch (err) {
		if (err instanceof SlicerError) {
			if (err.status !== 400 || err.detail) console.error('Quote failed:', err.message, err.detail ?? '');
			error(err.status, err.message);
		}
		console.error('Quote failed', err);
		error(500, 'Could not get a quote. Please try again.');
	}
};
