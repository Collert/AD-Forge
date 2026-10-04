/**
 * Customer login through Shopify's Customer Account API (Headless channel,
 * public client: OAuth 2 authorization code + PKCE, no client secret).
 *
 * The tokens live in an encrypted httpOnly cookie and never reach browser
 * JavaScript. The customer's email comes from the verified session, so it is
 * safe to use for choosing whose designs to show.
 */
import { env } from '$env/dynamic/private';
import type { Cookies } from '@sveltejs/kit';
import { base64url, seal, unseal } from './seal';

const CLIENT_ID = env.SHOPIFY_CUSTOMER_CLIENT_ID || 'f3017ef3-e4c4-4502-a79f-58a961852d05';
const AUTH_BASE = env.SHOPIFY_CUSTOMER_AUTH_URL || 'https://account.adbits.ca/authentication';
const GRAPHQL_URL = env.SHOPIFY_CUSTOMER_API_URL || 'https://account.adbits.ca/customer/api/2026-10/graphql';
const SCOPE = 'openid email customer-account-api:full';

const SESSION_COOKIE = 'ad_forge_session';
const FLOW_COOKIE = 'ad_forge_login';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

/** What the app knows about the signed-in customer. */
export type Account = {
	email: string;
	name: string | null;
	imageUrl: string | null;
};

type Session = Account & {
	accessToken: string;
	refreshToken: string;
	idToken: string;
	/** ms epoch the access token expires. */
	expiresAt: number;
};

type LoginFlow = { verifier: string; state: string; nonce: string; returnTo: string };

type TokenResponse = { access_token: string; refresh_token: string; id_token?: string; expires_in: number };

const cookieOptions = { path: '/', httpOnly: true, sameSite: 'lax' as const };

/**
 * The public URL of this app, for OAuth redirects. Behind a tunnel or proxy the
 * request may look like plain http, so ORIGIN can pin it. In production the
 * Node server reads the same variable for its own cross-site checks.
 */
export function appOrigin(url: URL) {
	return (env.ORIGIN || url.origin).replace(/\/$/, '');
}

// ---------- Login ----------

/** Start a login: remember the PKCE verifier and state, then send the customer to Shopify. */
export async function beginLogin(cookies: Cookies, url: URL, returnTo: string) {
	const flow: LoginFlow = { verifier: randomToken(), state: randomToken(), nonce: randomToken(), returnTo: safeReturn(returnTo) };
	cookies.set(FLOW_COOKIE, await seal(flow), { ...cookieOptions, maxAge: 600 });

	const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(flow.verifier))));
	const authorize = new URL(`${AUTH_BASE}/oauth/authorize`);
	authorize.search = new URLSearchParams({
		client_id: CLIENT_ID,
		scope: SCOPE,
		response_type: 'code',
		redirect_uri: `${appOrigin(url)}/account/callback`,
		state: flow.state,
		nonce: flow.nonce,
		code_challenge: challenge,
		code_challenge_method: 'S256'
	}).toString();
	return authorize.toString();
}

/** Finish a login from Shopify's redirect. Returns where to send the customer next. */
export async function completeLogin(cookies: Cookies, url: URL): Promise<string> {
	const flow = await unseal<LoginFlow>(cookies.get(FLOW_COOKIE));
	cookies.delete(FLOW_COOKIE, { path: '/' });

	const error = url.searchParams.get('error');
	if (error) throw new LoginError(url.searchParams.get('error_description') || error);
	if (!flow || url.searchParams.get('state') !== flow.state) throw new LoginError('This sign-in link has expired. Please try again.');
	const code = url.searchParams.get('code');
	if (!code) throw new LoginError('Shopify did not return a sign-in code.');

	const tokens = await tokenRequest(
		{
			grant_type: 'authorization_code',
			client_id: CLIENT_ID,
			redirect_uri: `${appOrigin(url)}/account/callback`,
			code,
			code_verifier: flow.verifier
		},
		url
	);
	const claims = decodeJwt(tokens.id_token);
	if (claims?.nonce !== flow.nonce) throw new LoginError('Sign-in could not be verified. Please try again.');

	const account = await fetchAccount(tokens.access_token);
	await saveSession(cookies, {
		...account,
		email: (account.email || String(claims.email ?? '')).toLowerCase(),
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		idToken: tokens.id_token ?? '',
		expiresAt: Date.now() + tokens.expires_in * 1000
	});
	return flow.returnTo;
}

export class LoginError extends Error {}

// ---------- Session ----------

/** The signed-in customer, refreshing the access token when it has expired. Null when signed out. */
export async function readSession(cookies: Cookies, url: URL): Promise<Account | null> {
	const session = await unseal<Session>(cookies.get(SESSION_COOKIE));
	if (!session) return null;
	if (Date.now() < session.expiresAt - 60_000) return publicPart(session);

	try {
		const tokens = await tokenRequest({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: session.refreshToken }, url);
		const next: Session = {
			...session,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token || session.refreshToken,
			expiresAt: Date.now() + tokens.expires_in * 1000
		};
		await saveSession(cookies, next);
		return publicPart(next);
	} catch (err) {
		console.warn('Customer session refresh failed; signing out.', err);
		cookies.delete(SESSION_COOKIE, { path: '/' });
		return null;
	}
}

/** Clear the session and return Shopify's logout URL, which comes back to `returnTo`. */
export async function logout(cookies: Cookies, url: URL) {
	const session = await unseal<Session>(cookies.get(SESSION_COOKIE));
	cookies.delete(SESSION_COOKIE, { path: '/' });
	if (!session?.idToken) return '/';
	const out = new URL(`${AUTH_BASE}/logout`);
	out.search = new URLSearchParams({ id_token_hint: session.idToken, post_logout_redirect_uri: `${appOrigin(url)}/` }).toString();
	return out.toString();
}

async function saveSession(cookies: Cookies, session: Session) {
	cookies.set(SESSION_COOKIE, await seal(session), { ...cookieOptions, maxAge: SESSION_MAX_AGE });
}

function publicPart({ email, name, imageUrl }: Session): Account {
	return { email, name, imageUrl };
}

// ---------- Shopify calls ----------

async function tokenRequest(params: Record<string, string>, url: URL): Promise<TokenResponse> {
	const res = await fetch(`${AUTH_BASE}/oauth/token`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			// Public clients are checked against the Headless channel's JavaScript origins.
			Origin: appOrigin(url),
			'User-Agent': 'AD-Forge'
		},
		body: new URLSearchParams(params),
		signal: AbortSignal.timeout(15_000)
	});
	if (!res.ok) throw new LoginError(`Shopify sign-in failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
	return res.json();
}

async function fetchAccount(accessToken: string): Promise<Account> {
	const res = await fetch(GRAPHQL_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: accessToken },
		body: JSON.stringify({ query: '{ customer { displayName imageUrl emailAddress { emailAddress } } }' }),
		signal: AbortSignal.timeout(15_000)
	});
	if (!res.ok) throw new LoginError(`Could not read your account (${res.status}).`);
	const body = await res.json();
	const customer = body.data?.customer;
	if (!customer) throw new LoginError(body.errors?.[0]?.message ?? 'Could not read your account.');
	return {
		email: String(customer.emailAddress?.emailAddress ?? '').toLowerCase(),
		name: customer.displayName || null,
		imageUrl: await realAvatar(customer.imageUrl)
	};
}

/**
 * Shopify's `imageUrl` is the customer's Gravatar (behind Shopify's image proxy)
 * with a generic silhouette as the fallback. Keep it only when a real Gravatar
 * exists, so customers without one get their initials instead.
 */
async function realAvatar(imageUrl: string | null | undefined): Promise<string | null> {
	if (!imageUrl) return null;
	const hash = imageUrl.match(/gravatar\.com\/avatar\/([0-9a-f]{32,64})/i)?.[1];
	if (!hash) return imageUrl;
	try {
		const res = await fetch(`https://www.gravatar.com/avatar/${hash}?s=100&d=404`, { method: 'HEAD', signal: AbortSignal.timeout(5_000) });
		return res.ok ? imageUrl : null;
	} catch {
		return null;
	}
}

// ---------- Helpers ----------

function randomToken() {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The id_token comes straight from Shopify's token endpoint over TLS, so its claims are read without re-checking the signature. */
function decodeJwt(token: string | undefined): Record<string, unknown> | null {
	try {
		const payload = token!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
		return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))));
	} catch {
		return null;
	}
}

/** Only same-site paths, so the login can't be used to redirect elsewhere. */
function safeReturn(path: string) {
	return path.startsWith('/') && !path.startsWith('//') ? path : '/';
}
