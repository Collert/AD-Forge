import { json } from '@sveltejs/kit';
import { isStaff } from '$lib/server/staff';
import type { RequestHandler } from './$types';

/** Whether the X-Staff-Token header holds the staff token. */
export const POST: RequestHandler = (event) => json({ staff: isStaff(event) });
