import { redirect } from '@sveltejs/kit';
import { defaults } from '$lib/catalog/config';

export const load = () => redirect(307, `/make/${defaults.processId}`);
