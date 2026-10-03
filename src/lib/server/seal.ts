/**
 * Encrypts small JSON values for cookies (AES-256-GCM, key derived from
 * SESSION_SECRET), so tokens stored in them can't be read or forged.
 */
import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';

let keyPromise: Promise<CryptoKey> | null = null;
let warned = false;

function key() {
	return (keyPromise ??= (async () => {
		let secret = env.SESSION_SECRET;
		if (!secret) {
			if (!dev) throw new Error('SESSION_SECRET must be set (see .env.example).');
			// Dev only: a per-process key, so sessions end when the server restarts.
			if (!warned) console.warn('SESSION_SECRET is not set; using a temporary key.');
			warned = true;
			secret = crypto.randomUUID();
		}
		const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
		return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
	})());
}

export async function seal(value: unknown): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(value)));
	return `${base64url(iv)}.${base64url(new Uint8Array(data))}`;
}

/** The sealed value, or null if it is missing, tampered with or from another key. */
export async function unseal<T>(sealed: string | undefined): Promise<T | null> {
	if (!sealed) return null;
	try {
		const [iv, data] = sealed.split('.').map(fromBase64url);
		const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await key(), data);
		return JSON.parse(new TextDecoder().decode(plain)) as T;
	} catch {
		return null;
	}
}

export function base64url(bytes: Uint8Array) {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string) {
	const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
