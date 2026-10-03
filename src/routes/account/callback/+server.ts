import { error, redirect } from '@sveltejs/kit';
import { LoginError, completeLogin } from '$lib/server/customer-account';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ cookies, url }) => {
	let next: string;
	try {
		next = await completeLogin(cookies, url);
	} catch (err) {
		console.error('Customer sign-in failed', err);
		error(400, err instanceof LoginError ? err.message : 'Sign-in failed. Please try again.');
	}
	redirect(303, next);
};
