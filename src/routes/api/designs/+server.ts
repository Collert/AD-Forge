import { error, json } from '@sveltejs/kit';
import { getCustomer } from '$lib/server/customer';
import { finalizeQuote, FinalizeError } from '$lib/server/finalize';
import { isStaff } from '$lib/server/staff';
import type { RequestHandler } from './$types';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Largest preview image accepted, bytes. */
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Finalize an accurate quote into a design the customer can order. Multipart
 * form: `quoteId`, `name`, and optionally `thumbnail` (PNG). With a staff token
 * (X-Staff-Token header), `ownerEmail` saves it for that customer instead.
 */
export const POST: RequestHandler = async (event) => {
	const form = await event.request.formData().catch(() => error(400, 'Expected a multipart form.'));

	// Staff mode: save into the library of the customer named by `ownerEmail`.
	const ownerEmail = String(form.get('ownerEmail') ?? '').trim().toLowerCase();
	let email: string;
	if (ownerEmail) {
		if (!isStaff(event)) error(403, 'Staff mode is not active in this browser.');
		if (!EMAIL.test(ownerEmail)) error(400, 'Enter a valid customer email.');
		email = ownerEmail;
	} else {
		const customer = getCustomer(event);
		if (!customer) error(401, 'Sign in to save and order your design.');
		email = customer.email;
	}

	const quoteId = String(form.get('quoteId') ?? '');
	const name = String(form.get('name') ?? '');
	const thumbnail = form.get('thumbnail');
	const bytes = thumbnail instanceof File && thumbnail.size <= MAX_THUMBNAIL_BYTES ? new Uint8Array(await thumbnail.arrayBuffer()) : null;
	const png = bytes && PNG_SIGNATURE.every((b, i) => bytes[i] === b) ? bytes : null;

	try {
		return json(await finalizeQuote(quoteId, email, name, png));
	} catch (err) {
		if (err instanceof FinalizeError) error(err.status, err.message);
		console.error('Could not finalize design', err);
		error(502, "Couldn't save your design right now. Please try again.");
	}
};
