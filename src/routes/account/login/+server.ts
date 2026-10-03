import { redirect } from '@sveltejs/kit';
import { beginLogin } from '$lib/server/customer-account';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ cookies, url }) => {
	redirect(303, await beginLogin(cookies, url, url.searchParams.get('returnTo') ?? '/library'));
};
