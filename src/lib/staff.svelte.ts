/**
 * Staff mode (see $lib/server/staff.ts): the staff token kept in this
 * browser's localStorage. Open any page with `?staff=<token>` to store it, or
 * `?staff=off` to forget it. `staff.active` turns on once the server confirms
 * the token matches STAFF_TOKEN.
 */
import { browser } from '$app/environment';

const STORAGE_KEY = 'ad-staff-token';

export const staff = $state({ active: false });

export function staffToken(): string | null {
	return browser ? localStorage.getItem(STORAGE_KEY) : null;
}

/** Headers that carry the staff token, if this browser has one. */
export function staffHeaders(): Record<string, string> {
	const token = staffToken();
	return token ? { 'X-Staff-Token': token } : {};
}

/** Store or clear a token from the URL, then check it with the server. Returns whether the URL had one. */
export async function initStaff(url: URL): Promise<boolean> {
	const param = url.searchParams.get('staff');
	if (param === 'off' || param === '') localStorage.removeItem(STORAGE_KEY);
	else if (param) localStorage.setItem(STORAGE_KEY, param);

	if (!staffToken()) {
		staff.active = false;
	} else {
		const res = await fetch('/api/staff', { method: 'POST', headers: staffHeaders() }).catch(() => null);
		staff.active = (await res?.json().catch(() => null))?.staff === true;
	}
	return param !== null;
}
