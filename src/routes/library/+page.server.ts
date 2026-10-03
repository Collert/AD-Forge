import { fail } from '@sveltejs/kit';
import { getCustomer } from '$lib/server/customer';
import { EXPIRING_DAYS, RETENTION_DAYS, getFinalizedDesigns, renewDesign, type DesignsResult } from '$lib/server/designs';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const customer = getCustomer(event);
	// Streamed: drafts (local) render at once while Shopify answers.
	return {
		customer,
		retentionDays: RETENTION_DAYS,
		expiringDays: EXPIRING_DAYS,
		finalized: customer
			? getFinalizedDesigns(customer.email)
			: Promise.resolve<DesignsResult>({ ok: false, reason: 'signed-out', designs: [] })
	};
};

export const actions: Actions = {
	/** Keep a finalized design for RETENTION_DAYS from today (resets the clock, never adds to it). */
	renew: async (event) => {
		const customer = getCustomer(event);
		if (!customer) return fail(401, { message: 'Sign in to renew your designs.' });
		const id = String((await event.request.formData()).get('id') ?? '');
		if (!id.startsWith('gid://shopify/Product/')) return fail(400, { message: 'Design not found.' });
		try {
			const result = await renewDesign(customer.email, id);
			if (!result.ok) return fail(result.status, { message: result.message });
			return { renewed: result.design.id, expiresAt: result.design.expiresAt };
		} catch (err) {
			console.error('Could not renew design', err);
			return fail(502, { message: "Couldn't renew this design right now. Please try again." });
		}
	}
};
