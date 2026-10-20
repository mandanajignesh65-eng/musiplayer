// Google sign-in. Used by both the page and the service worker, so tokens live in Cache Storage,
// which both can read. The refresh token keeps you signed in, so you sign in only once per device.
import { CLIENT_ID, CLIENT_SECRET } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STORE = 'auth-v1';
const KEY = 'tokens';

export class SignedOut extends Error {}

export const redirectUri = () => new URL('./', self.location.href).href;

async function load() {
  const hit = await (await caches.open(STORE)).match(KEY);
  return hit ? hit.json() : null;
}

async function save(tokens) {
  const cache = await caches.open(STORE);
  if (tokens) await cache.put(KEY, new Response(JSON.stringify(tokens)));
  else await cache.delete(KEY);
}

export async function isSignedIn() {
  return !!(await load())?.refresh;
}

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function signIn() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem('pkce', JSON.stringify({ verifier, state }));
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

// After Google sends you back with ?code=..., trade the code for tokens. Returns true if it did.
export async function finishSignIn() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return false;
  history.replaceState(null, '', redirectUri());
  const saved = JSON.parse(sessionStorage.getItem('pkce') || '{}');
  sessionStorage.removeItem('pkce');
  if (error) throw new Error(`Google sign-in was cancelled (${error}).`);
  if (url.searchParams.get('state') !== saved.state) throw new Error('Sign-in check failed. Please try again.');
  const res = await tokenRequest({
    grant_type: 'authorization_code', code, code_verifier: saved.verifier, redirect_uri: redirectUri(),
  });
  if (!res.refresh_token) throw new Error('Google did not return a refresh token. Please sign in again.');
  await save({ access: res.access_token, expiresAt: Date.now() + res.expires_in * 1000, refresh: res.refresh_token });
  return true;
}

async function tokenRequest(fields) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...fields }),
  });
  const body = await r.json();
  if (!r.ok) {
    if (body.error === 'invalid_grant') {
      await save(null);
      throw new SignedOut('Your Google sign-in has ended. Please sign in again.');
    }
    throw new Error(`Google sign-in error: ${body.error_description || body.error || r.status}`);
  }
  return body;
}

let refreshing = null;

// Returns a valid access token, getting a new one from the refresh token when the old one is about to end.
export async function getToken({ force = false } = {}) {
  const tokens = await load();
  if (!tokens?.refresh) throw new SignedOut('Not signed in.');
  if (!force && tokens.expiresAt - 60_000 > Date.now()) return tokens.access;
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh })
    .then(async (res) => {
      await save({ ...tokens, access: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 });
      return res.access_token;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function signOut() {
  const tokens = await load();
  await save(null);
  if (tokens?.refresh) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.refresh)}`, { method: 'POST' }).catch(() => {});
  }
}
