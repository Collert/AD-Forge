import type { Handle, ServerInit } from '@sveltejs/kit';
import { getCatalog } from '$lib/server/catalog';
import { readSession } from '$lib/server/customer-account';

// Warm the catalog cache at startup so the first visitor doesn't wait on Shopify.
export const init: ServerInit = () => {
	getCatalog().catch((err) => console.error('Could not warm the catalog cache', err));
};

// The signed-in customer (if any), refreshed when their access token has expired.
export const handle: Handle = async ({ event, resolve }) => {
	event.locals.account = await readSession(event.cookies, event.url);
	return resolve(event);
};
