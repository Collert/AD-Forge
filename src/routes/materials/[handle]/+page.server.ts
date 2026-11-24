import { error } from '@sveltejs/kit';
import { getFilament } from '$lib/server/library';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	let found: Awaited<ReturnType<typeof getFilament>>;
	try {
		found = await getFilament(params.handle);
	} catch (err) {
		console.error('Could not load the Materials Library from Shopify', err);
		error(503, 'The Materials Library is unavailable right now. Please try again in a minute.');
	}
	if (!found) error(404, 'We don’t carry that material.');
	setHeaders({ 'cache-control': 'public, max-age=300' });
	return found;
};
