/**
 * Filament inventory from Spoolman (https://donkie.github.io/Spoolman/): which
 * filaments have a spool on the shelf, and the manufacturer's restock ETA
 * (the filament's `next_restock_date` extra field) for ones the supplier is
 * out of too, and which the manufacturer has discontinued (`discontinued`).
 * Behind HTTP basic auth; configured with SPOOLMAN_URL, SPOOLMAN_USERNAME
 * and SPOOLMAN_PASSWORD. Unset URL: Spoolman isn't used.
 */
import { env } from '$env/dynamic/private';

/** Extra field (on filaments) holding the manufacturer's restock ETA. */
const RESTOCK_FIELD = 'next_restock_date';
/** Boolean extra field (on filaments): the manufacturer no longer makes it, so it won't be restocked. */
const DISCONTINUED_FIELD = 'discontinued';

export type SpoolmanFilament = {
	id: number;
	name: string | null;
	material: string | null;
	vendor: { name: string } | null;
	color_hex: string | null;
	article_number: string | null;
	external_id: string | null;
	/** Every value is JSON-encoded, whatever the field's type. */
	extra: Record<string, string>;
};

type SpoolmanSpool = {
	id: number;
	filament: SpoolmanFilament;
	remaining_weight: number | null;
	archived: boolean;
};

export type SpoolmanInventory = {
	filaments: SpoolmanFilament[];
	/** Filament ids with at least one unarchived spool that has filament left. */
	onHand: Set<number>;
};

export function spoolmanConfigured() {
	return !!env.SPOOLMAN_URL;
}

async function get<T>(path: string): Promise<T> {
	const base = env.SPOOLMAN_URL!.replace(/\/+$/, '');
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (env.SPOOLMAN_USERNAME || env.SPOOLMAN_PASSWORD) {
		const credentials = Buffer.from(`${env.SPOOLMAN_USERNAME ?? ''}:${env.SPOOLMAN_PASSWORD ?? ''}`).toString('base64');
		headers.Authorization = `Basic ${credentials}`;
	}
	const res = await fetch(`${base}/api/v1${path}`, { headers, signal: AbortSignal.timeout(15_000) });
	if (!res.ok) throw new Error(`Spoolman responded ${res.status} ${res.statusText} for ${path}`);
	return (await res.json()) as T;
}

/** Every filament and which of them are on hand. */
export async function fetchSpoolmanInventory(): Promise<SpoolmanInventory> {
	const [filaments, spools] = await Promise.all([get<SpoolmanFilament[]>('/filament'), get<SpoolmanSpool[]>('/spool')]);
	const onHand = new Set<number>();
	for (const s of spools) {
		// Spools without a weight are untracked: count them as on hand.
		if (!s.archived && (s.remaining_weight === null || s.remaining_weight > 0)) onHand.add(s.filament.id);
	}
	return { filaments, onHand };
}

/** A JSON-decoded extra field, as a string; undefined when unset or unreadable. */
export function extraField(filament: SpoolmanFilament, key: string): string | undefined {
	const raw = filament.extra?.[key];
	if (raw === undefined) return undefined;
	try {
		const value = JSON.parse(raw) as unknown;
		return value === null || value === '' ? undefined : String(value);
	} catch {
		return raw || undefined;
	}
}

export function isDiscontinued(filament: SpoolmanFilament) {
	return extraField(filament, DISCONTINUED_FIELD) === 'true';
}

/** The manufacturer's restock ETA as an ISO date (YYYY-MM-DD); undefined when they have it in stock. */
export function restockDate(filament: SpoolmanFilament): string | undefined {
	const value = extraField(filament, RESTOCK_FIELD);
	const date = value?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
	return date && Number.isFinite(Date.parse(date)) ? date : undefined;
}
