import { error, json } from '@sveltejs/kit';
import { getCustomer } from '$lib/server/customer';
import { finalizeQuote, FinalizeError } from '$lib/server/finalize';
import type { RequestHandler } from './$types';

/** Largest preview image accepted, bytes. */
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Finalize an accurate quote into a design the customer can order. Multipart
 * form: `quoteId`, `name`, and optionally `thumbnail` (PNG).
 */
export const POST: RequestHandler = async (event) => {
	const customer = getCustomer(event);
	if (!customer) error(401, 'Sign in to save and order your design.');

	const form = await event.request.formData().catch(() => error(400, 'Expected a multipart form.'));
	const quoteId = String(form.get('quoteId') ?? '');
	const name = String(form.get('name') ?? '');
	const thumbnail = form.get('thumbnail');
	const bytes = thumbnail instanceof File && thumbnail.size <= MAX_THUMBNAIL_BYTES ? new Uint8Array(await thumbnail.arrayBuffer()) : null;
	const png = bytes && PNG_SIGNATURE.every((b, i) => bytes[i] === b) ? bytes : null;

	try {
		return json(await finalizeQuote(quoteId, customer.email, name, png));
	} catch (err) {
		if (err instanceof FinalizeError) error(err.status, err.message);
		console.error('Could not finalize design', err);
		error(502, "Couldn't save your design right now. Please try again.");
	}
};
