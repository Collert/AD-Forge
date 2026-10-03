/**
 * Who is browsing: the customer signed in through the Customer Account API
 * (see customer-account.ts), read once per request in hooks.server.ts.
 *
 * In local dev, where Shopify can't redirect back to http://localhost, a
 * signed-out visitor is treated as DEV_CUSTOMER_EMAIL (default
 * mytyber@gmail.com) so the library still shows designs. Never in production.
 */
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import type { RequestEvent } from '@sveltejs/kit';

const DEV_PLACEHOLDER_EMAIL = 'mytyber@gmail.com';

export type Customer = { email: string; /** False for the dev placeholder. */ authenticated: boolean };

export function getCustomer(event: RequestEvent): Customer | null {
	const account = event.locals.account;
	if (account?.email) return { email: account.email, authenticated: true };
	if (dev) return { email: (env.DEV_CUSTOMER_EMAIL || DEV_PLACEHOLDER_EMAIL).trim().toLowerCase(), authenticated: false };
	return null;
}
