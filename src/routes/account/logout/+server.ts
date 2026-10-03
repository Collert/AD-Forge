import { redirect } from '@sveltejs/kit';
import { logout } from '$lib/server/customer-account';
import type { RequestHandler } from './$types';

// POST so a link or prefetch can't sign someone out.
export const POST: RequestHandler = async ({ cookies, url }) => {
	redirect(303, await logout(cookies, url));
};
