/**
 * Staff mode: a browser whose localStorage holds STAFF_TOKEN may save designs
 * into another customer's library. The token travels in the X-Staff-Token
 * header (see $lib/staff.svelte.ts). Unset STAFF_TOKEN: staff mode is off.
 */
import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import type { RequestEvent } from '@sveltejs/kit';

export const STAFF_HEADER = 'x-staff-token';

export function isStaffToken(token: string | null | undefined): boolean {
	const expected = env.STAFF_TOKEN?.trim();
	if (!expected || !token) return false;
	const a = Buffer.from(token.trim());
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function isStaff(event: RequestEvent): boolean {
	return isStaffToken(event.request.headers.get(STAFF_HEADER));
}
