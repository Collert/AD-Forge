import { error } from '@sveltejs/kit';
import { getLibrary } from '$lib/server/library';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ setHeaders }) => {
	try {
		const library = await getLibrary();
		setHeaders({ 'cache-control': 'public, max-age=300' });
		return { library };
	} catch (err) {
		console.error('Could not load the Materials Library from Shopify', err);
		error(503, 'The Materials Library is unavailable right now. Please try again in a minute.');
	}
};
