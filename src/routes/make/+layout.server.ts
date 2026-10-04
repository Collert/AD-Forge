import { error } from '@sveltejs/kit';
import { getCatalog } from '$lib/server/catalog';
import { getCustomer } from '$lib/server/customer';
import type { LayoutServerLoad } from './$types';

// Reads nothing from the URL, so it runs once per visit: switching processes or parts reuses it.
export const load: LayoutServerLoad = async (event) => {
	try {
		return {
			catalog: await getCatalog(),
			/** Whether finalizing a quote will be accepted, or the customer must sign in first. */
			canSave: getCustomer(event) !== null
		};
	} catch (err) {
		console.error('Could not load the catalog from Shopify', err);
		error(503, 'Materials are unavailable right now. Please try again in a minute.');
	}
};
